// SPDX-License-Identifier: MIT
/**
 * Local end-to-end chain check: sidecar + WebMCP + match runner.
 *
 * Boots the whole MIT-sidecar chain with NO live game and NO browser:
 *   1. the sidecar server (`server/`, REST + WebSocket on PORT, default 8787)
 *   2. the generator-based ROTT WebMCP server
 *      (`packages/webmcp-generator/examples/rott-adapter/rott-server.mjs`,
 *      driven by `docs/openapi.yaml`, on WEBMCP_PORT, default 3200)
 *   3. the match runner (`match-runner/match-runner.mjs`) with mock agents
 *      (agent-1, agent-2), whose `callTool` is the WebMCP server's
 *      `POST /tools/call` endpoint — the same path real agents use.
 *
 * Then asserts each link: sidecar health, the WebMCP tool list, a `getState`
 * tool call, a `sendChat`/`listChat` round-trip through the tools, the
 * WebSocket smoke test (`server/tests/ws-smoke.mjs`) against the live
 * sidecar, and a short match through the runner.
 *
 * Honest limits (read before trusting a green run):
 * - Without a game page connected to the sidecar bridge, gameplay tools
 *   (`newGame`, `hostMultiplayer`, `quitGame`, input, screen, ...) return
 *   BRIDGE_OFFLINE by design. The match step therefore ABORTS with that
 *   error in this mode; the script asserts the failure is exactly the
 *   bridge-offline error (proving the runner reached the WebMCP server
 *   and the chain is wired) and reports the match as SKIPPED, never as
 *   passed. A live-browser, live-game match still needs a Chrome run
 *   (see `docs/chrome-verification.md`, lane L34).
 * - When a bridge IS connected (`/health` reports `bridgeConnected:
 *   true`), the match step runs for real and must complete and record a
 *   result; a `scores-unobserved` end with no winner is a legitimate
 *   outcome there (agents that never report a score), not a failure.
 *
 * Usage (from the repo root):
 *   node scripts/e2e-local.mjs
 *
 * Env:
 *   E2E_SIDECAR_PORT   sidecar port (default 8787)
 *   E2E_WEBMCP_PORT    WebMCP server port (default 3200)
 *   E2E_MATCH_SECONDS  match time limit in seconds, live-game mode only
 *                       (default 10)
 *   E2E_KEEP_SERVERS   set to 1 to leave both servers running after the
 *                       run (for manual poking); otherwise they are killed.
 *
 * Exit code: 0 when every check that can run without a live game passes
 * (match skipped-for-no-bridge counts as a skip, not a failure); 1 on any
 * real failure. Both servers are stopped on exit unless E2E_KEEP_SERVERS=1.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const SERVER_DIR = join(ROOT, "server");
const SPEC_PATH = join(ROOT, "docs", "openapi.yaml");
const ADAPTER_PATH = join(
  ROOT,
  "packages",
  "webmcp-generator",
  "examples",
  "rott-adapter",
  "rott-server.mjs",
);
const GENERATOR_DIR = join(ROOT, "packages", "webmcp-generator");
const MATCH_RUNNER_PATH = join(ROOT, "match-runner", "match-runner.mjs");
const WS_SMOKE_PATH = join(ROOT, "server", "tests", "ws-smoke.mjs");

const SIDECAR_PORT = Number(process.env.E2E_SIDECAR_PORT ?? 8787);
const WEBMCP_PORT = Number(process.env.E2E_WEBMCP_PORT ?? 3200);
const MATCH_SECONDS = Number(process.env.E2E_MATCH_SECONDS ?? 10);
const KEEP_SERVERS = process.env.E2E_KEEP_SERVERS === "1";

const SIDECAR_URL = `http://localhost:${SIDECAR_PORT}`;
const WEBMCP_URL = `http://localhost:${WEBMCP_PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let skips = 0;
function check(label, condition, detail = "") {
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!condition) failures++;
}
function skip(label, detail = "") {
  skips++;
  console.log(`SKIP  ${label}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 180_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed in ${cwd}: ${error.message}\n${stdout}\n${stderr}`,
          ),
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function ensureBuilt(dir, distEntry, label) {
  if (existsSync(join(dir, distEntry))) return;
  console.log(`${label}: ${distEntry} missing, building…`);
  if (!existsSync(join(dir, "node_modules"))) {
    await run("npm", ["install", "--no-audit", "--no-fund"], dir);
  }
  await run("npm", ["run", "build"], dir);
  if (!existsSync(join(dir, distEntry))) {
    throw new Error(`${label}: build did not produce ${distEntry}`);
  }
}

async function waitForHttp(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} at ${url} (${lastError})`);
}

function startServer(command, args, cwd, env, label) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  return child;
}

async function callTool(name, args = {}) {
  const res = await fetch(`${WEBMCP_URL}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  });
  return res.json();
}

let sidecar = null;
let webmcp = null;
try {
  // ---- 0. Preconditions: every piece of the chain must exist. ----
  for (const [path, label] of [
    [join(SERVER_DIR, "package.json"), "sidecar server/"],
    [SPEC_PATH, "docs/openapi.yaml"],
    [ADAPTER_PATH, "generator rott-adapter"],
    [join(GENERATOR_DIR, "package.json"), "webmcp-generator package"],
    [MATCH_RUNNER_PATH, "match-runner"],
    [WS_SMOKE_PATH, "server/tests/ws-smoke.mjs"],
  ]) {
    check(`${label} exists`, existsSync(path), path);
  }
  if (failures > 0) throw new Error("missing chain components; see FAILs above");

  // ---- 1. Boot the sidecar. ----
  await ensureBuilt(SERVER_DIR, join("dist", "server.js"), "sidecar");
  sidecar = startServer("node", ["dist/server.js"], SERVER_DIR, {
    PORT: String(SIDECAR_PORT),
  }, "sidecar");
  const healthRes = await waitForHttp(
    `${SIDECAR_URL}/health`,
    20_000,
    "sidecar /health",
  );
  const health = await healthRes.json();
  check("sidecar /health answers", true, JSON.stringify(health));
  const bridgeConnected = health.bridgeConnected === true;
  console.log(
    `sidecar bridge: ${bridgeConnected ? "CONNECTED (live game)" : "offline (no game page — expected locally)"}`,
  );

  // ---- 2. Boot the generator-based WebMCP server. ----
  await ensureBuilt(GENERATOR_DIR, join("dist", "index.js"), "webmcp-generator");
  webmcp = startServer(
    "node",
    [ADAPTER_PATH, SPEC_PATH, String(WEBMCP_PORT)],
    GENERATOR_DIR,
    { ROTT_SIDECAR_URL: SIDECAR_URL },
    "webmcp",
  );
  const toolsRes = await waitForHttp(`${WEBMCP_URL}/tools`, 20_000, "webmcp /tools");
  const { tools } = await toolsRes.json();
  const toolNames = (tools ?? []).map((t) => t.name);
  check("webmcp /tools answers", Array.isArray(tools), `${toolNames.length} tools`);
  for (const needed of [
    "getState",
    "getHealth",
    "newGame",
    "hostMultiplayer",
    "quitGame",
    "sendChat",
    "listChat",
  ]) {
    check(`webmcp tool present: ${needed}`, toolNames.includes(needed));
  }

  // ---- 3. Drive the sidecar through the WebMCP tools. ----
  const state = await callTool("getState", {});
  check(
    "getState via /tools/call",
    state.ok === true && typeof state.data === "object" && state.data !== null,
    state.ok ? `status=${state.data.status}` : JSON.stringify(state.error),
  );

  const chatText = `e2e-local ping ${Date.now()}`;
  const sent = await callTool("sendChat", {
    from: "e2e-local",
    text: chatText,
    to: null,
  });
  check("sendChat via /tools/call", sent.ok === true, JSON.stringify(sent.error ?? sent.data));
  const chat = await callTool("listChat", {});
  check(
    "listChat round-trips the sent message",
    chat.ok === true &&
      Array.isArray(chat.data) &&
      chat.data.some((m) => m.from === "e2e-local" && m.text === chatText),
    chat.ok ? `${chat.data.length} message(s)` : JSON.stringify(chat.error),
  );

  // ---- 4. WebSocket smoke test against the live sidecar. ----
  // (ws-smoke.mjs targets the default port 8787, like lane-2's original.)
  if (SIDECAR_PORT !== 8787) {
    skip(
      "ws-smoke.mjs (sidecar on a non-default port)",
      `ws-smoke targets ws://localhost:8787/ws; sidecar is on ${SIDECAR_PORT}`,
    );
  } else {
  const wsResult = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [WS_SMOKE_PATH],
      { env: { ...process.env, PORT: String(SIDECAR_PORT) } },
    );
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (error) => resolve({ code: -1, out: String(error) }));
  });
  console.log(wsResult.out.trim());
  check(
    "ws-smoke.mjs passes against the live sidecar",
    wsResult.code === 0 && wsResult.out.includes("WS-OK"),
    `exit=${wsResult.code}`,
  );
  }

  // ---- 5. Match runner over the real WebMCP tools, with mock agents. ----
  const { createMatchRunner } = await import(MATCH_RUNNER_PATH);
  const resultsDir = await mkdtemp(join(tmpdir(), "rott-e2e-local-"));
  const runner = createMatchRunner({
    callTool: (name, args) => callTool(name, args),
    resultsDir,
    tickMs: 100,
  });
  const agents = [{ name: "agent-1" }, { name: "agent-2" }];
  if (!bridgeConnected) {
    // No live game: gameplay tools must fail with the sidecar's
    // BRIDGE_OFFLINE error (HTTP 503). Prove that FIRST with a direct
    // tool call — the generator surfaces the sidecar's structured error
    // body in error.details, while the match runner only surfaces
    // "HTTP 503", so the direct call is the precise check.
    const newGame = await callTool("newGame", {
      episode: 1,
      level: 1,
      difficulty: "normal",
    });
    const detailsText = JSON.stringify(newGame.error?.details ?? newGame.error ?? "");
    check(
      "newGame via /tools/call fails BRIDGE_OFFLINE (not a wiring failure)",
      newGame.ok === false &&
        newGame.status === 503 &&
        /BRIDGE_OFFLINE/i.test(detailsText),
      `status=${newGame.status} details=${detailsText.slice(0, 200)}`,
    );
    // Then the match must abort (it starts with newGame). The cause is
    // already proven above, so any throw here is the expected outcome.
    let matchError = "";
    try {
      await runner.startMatch({
        format: "score-attack",
        agents,
        episode: 1,
        level: 1,
        difficulty: "normal",
        timeLimitSec: MATCH_SECONDS,
      });
    } catch (error) {
      matchError = error instanceof Error ? error.message : String(error);
    }
    check(
      "match aborts without a live game",
      matchError.length > 0,
      matchError || "match unexpectedly succeeded without a game",
    );
    skip(
      "live match (needs a game page in Chrome)",
      "no bridge connected; run again with the game open — see docs/chrome-verification.md",
    );
    console.log(`match results dir (empty, kept for inspection): ${resultsDir}`);
  } else {
    const result = await runner.startMatch({
      format: "score-attack",
      agents,
      episode: 1,
      level: 1,
      difficulty: "normal",
      timeLimitSec: MATCH_SECONDS,
    });
    check("live match completes and records a result", typeof result.id === "string", JSON.stringify(result));
    console.log(
      `live match: winner=${result.winner} endReason=${result.endReason} scores=${JSON.stringify(result.scores)}`,
    );
    const recorded = await runner.loadResults();
    check("match result persisted", recorded.length >= 1, `${recorded.length} recorded`);
    const board = await runner.getLeaderboard();
    check("leaderboard readable", Array.isArray(board.leaderboard), JSON.stringify(board.leaderboard));
    console.log(`match results dir: ${resultsDir}`);
  }
} catch (error) {
  failures++;
  console.error(`ERROR  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (!KEEP_SERVERS) {
    for (const [child, label] of [[webmcp, "webmcp"], [sidecar, "sidecar"]]) {
      if (child && !child.killed) {
        child.kill("SIGTERM");
        console.log(`stopped ${label} server`);
      }
    }
  } else {
    console.log("E2E_KEEP_SERVERS=1: servers left running");
    console.log(`  sidecar: ${SIDECAR_URL}   webmcp: ${WEBMCP_URL}`);
  }
}

console.log(
  failures === 0
    ? `\nE2E-LOCAL ${skips > 0 ? `PASSED (${skips} skipped: live-game match needs Chrome)` : "PASSED"}`
    : `\nE2E-LOCAL FAILED (${failures} failure(s))`,
);
process.exit(failures === 0 ? 0 : 1);
