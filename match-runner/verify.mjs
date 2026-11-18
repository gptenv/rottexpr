// SPDX-License-Identifier: MIT
/**
 * Structural end-to-end verification for the match runner.
 *
 * Runs two matches against the mock tool backend (no live sidecar or
 * game): a Comm-bat deathmatch (frag limit 3 — agent-1 scores every
 * poll, agent-2 every second poll, so agent-1 must win on the frag
 * limit) and a score attack (two sequential runs; agent-1's run scores
 * on every poll while agent-2's run is cut short by the time limit, so
 * agent-1 must win on score). Asserts results are recorded and the
 * leaderboard reflects them. Exits 0 only if every check passes.
 *
 *   node verify.mjs
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMatchRunner } from "./match-runner.mjs";
import { createMockBackend } from "./mock-agents.mjs";

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

const dir = await mkdtemp(join(tmpdir(), "rott-match-verify-"));
const mock = createMockBackend();
const runner = createMatchRunner({
  callTool: mock.callTool,
  resultsDir: dir,
  tickMs: 5,
});

// 1. Comm-bat deathmatch, frag limit 3, generous time limit.
const deathmatch = await runner.startMatch({
  format: "comm-bat",
  agents: [{ name: "agent-1" }, { name: "agent-2" }],
  episode: 1,
  level: 1,
  fragLimit: 3,
  timeLimitSec: 30,
});
check(
  "comm-bat ends on the frag limit",
  deathmatch.endReason === "frag-limit",
  deathmatch.endReason,
);
check(
  "comm-bat winner is agent-1 (scores every poll)",
  deathmatch.winner === "agent-1",
  `winner=${deathmatch.winner}`,
);
check(
  "comm-bat scores recorded",
  deathmatch.scores["agent-1"] === 3 && deathmatch.scores["agent-2"] <= 2,
  JSON.stringify(deathmatch.scores),
);

// 2. Score attack: two sequential runs of the same episode/level.
// (The mock scripts run 0 = agent-1 at 2 points per poll and run 1 =
// agent-2 at 1 point per poll, so agent-1 must win on score.)
const attack = await runner.startMatch({
  format: "score-attack",
  agents: [{ name: "agent-1" }, { name: "agent-2" }],
  episode: 1,
  level: 1,
  difficulty: "normal",
  timeLimitSec: 0.05,
});
check(
  "score-attack records a winner",
  attack.winner === "agent-1",
  `winner=${attack.winner} scores=${JSON.stringify(attack.scores)}`,
);
check(
  "score-attack ends on the time limit",
  attack.endReason === "time-limit",
  attack.endReason,
);

// 3. Results persisted and leaderboard aggregates.
const results = await runner.loadResults();
check("two results recorded", results.length === 2, `${results.length} recorded`);
const board = await runner.getLeaderboard();
const agent1 = board.leaderboard.find((e) => e.agent === "agent-1");
check(
  "leaderboard: agent-1 has 2 wins, 2 matches",
  agent1?.wins === 2 && agent1?.matches === 2,
  JSON.stringify(agent1),
);
const agent2 = board.leaderboard.find((e) => e.agent === "agent-2");
check(
  "leaderboard: agent-2 has 0 wins, 2 matches",
  agent2?.wins === 0 && agent2?.matches === 2,
  JSON.stringify(agent2),
);
const html = (await import("./match-runner.mjs")).renderLeaderboardHTML(board);
check(
  "leaderboard HTML renders both agents",
  html.includes("agent-1") && html.includes("agent-2"),
);

// 4. Validation: comm-bat with one agent is rejected.
let rejected = false;
try {
  await runner.startMatch({
    format: "comm-bat",
    agents: [{ name: "agent-1" }],
    timeLimitSec: 1,
  });
} catch (error) {
  rejected = /at least 2 agents/.test(error.message);
}
check("comm-bat with 1 agent is rejected", rejected);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
console.log(`results dir (kept for inspection): ${dir}`);
process.exit(failures === 0 ? 0 : 1);
