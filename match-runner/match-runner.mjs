// SPDX-License-Identifier: MIT
/**
 * ROTT match runner (Phase 8).
 *
 * Agents play ONLY through the published WebMCP tools — the runner is
 * constructed with a single `callTool(name, args)` function (the WebMCP
 * executor) and never touches REST, WebSocket, the engine, or WASM memory
 * directly. It starts games, enforces rules, records results, and keeps
 * a leaderboard.
 *
 * Formats:
 *   - "comm-bat": multiplayer deathmatch. One hosted game
 *     (hostMultiplayer), all agents in it. Ends when an agent reaches
 *     the frag limit or the time limit expires.
 *   - "score-attack": single-player episodes. Each agent plays its own
 *     run (newGame) of the same episode/level/difficulty for the same
 *     time limit; highest score wins.
 *
 * Scores — the honest limitation: the bridge observes ONE game state
 * (ObservableState), not per-agent frag counts; there is no per-agent
 * score in the published interfaces. So agents report their score
 * through the chat channel (`sendChat` with text `score: <n>`, from =
 * agent id) and the runner reads them back with `listChat`, cross-checking
 * against the observable `getState().score` when it is non-null. A match
 * whose agents never report a score is recorded with winner `null` and
 * endReason `scores-unobserved` — never invented.
 *
 * Results are appended as JSON lines to `<resultsDir>/results.jsonl` and
 * aggregated into `<resultsDir>/leaderboard.json`.
 */
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TICK_MS = 1000;
const SCORE_RE = /^score\s*:\s*(\d+)\s*$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMatchRunner(deps) {
  const callTool = deps.callTool;
  const resultsDir = deps.resultsDir ?? "./results";
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  const sleeper = deps.sleep ?? sleep;
  const now = deps.now ?? (() => new Date());

  if (typeof callTool !== "function") {
    throw new Error("createMatchRunner requires a callTool(name, args) function");
  }

  async function tool(name, args = {}) {
    const result = await callTool(name, args);
    if (!result.ok) {
      throw new Error(
        `tool "${name}" failed: ${result.error?.message ?? `HTTP ${result.status}`}`,
      );
    }
    return result.data;
  }

  async function collectScores(agentNames) {
    const scores = {};
    try {
      const messages = await tool("listChat", {});
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (!msg || typeof msg.text !== "string") continue;
          if (!agentNames.includes(msg.from)) continue;
          const match = SCORE_RE.exec(msg.text);
          if (match) scores[msg.from] = Number(match[1]);
        }
      }
    } catch {
      // chat history unavailable; scores stay as reported so far
    }
    return scores;
  }

  async function observedScore() {
    try {
      const s = await tool("getState", {});
      return typeof s?.score === "number" ? s.score : null;
    } catch {
      return null;
    }
  }

  async function endGame(format) {
    try {
      if (format === "comm-bat") await tool("leaveMultiplayer", {});
    } catch {
      // best-effort teardown
    }
    try {
      await tool("quitGame", {});
    } catch {
      // best-effort teardown
    }
  }

  async function recordResult(result) {
    await mkdir(resultsDir, { recursive: true });
    await appendFile(
      join(resultsDir, "results.jsonl"),
      `${JSON.stringify(result)}\n`,
      "utf-8",
    );
    await rebuildLeaderboard();
    return result;
  }

  async function loadResults() {
    const path = join(resultsDir, "results.jsonl");
    if (!existsSync(path)) return [];
    const text = await readFile(path, "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async function rebuildLeaderboard() {
    const results = await loadResults();
    const board = {};
    for (const result of results) {
      for (const name of result.agents ?? []) {
        board[name] ??= { agent: name, wins: 0, matches: 0, bestScore: 0, lastPlayed: null };
        board[name].matches++;
        const score = result.scores?.[name];
        if (typeof score === "number") {
          board[name].bestScore = Math.max(board[name].bestScore, score);
        }
        board[name].lastPlayed = result.endedAt;
      }
      if (result.winner && board[result.winner]) board[result.winner].wins++;
    }
    const leaderboard = Object.values(board).sort(
      (a, b) => b.wins - a.wins || b.bestScore - a.bestScore,
    );
    await writeFile(
      join(resultsDir, "leaderboard.json"),
      `${JSON.stringify({ updatedAt: now().toISOString(), leaderboard }, null, 2)}\n`,
      "utf-8",
    );
    return leaderboard;
  }

  /**
   * Run one match to completion.
   * config: {format, agents:[{id?, name}], episode, level, difficulty,
   *          maxPlayers, fragLimit, timeLimitSec}
   */
  async function startMatch(config) {
    const format = config.format;
    if (format !== "comm-bat" && format !== "score-attack") {
      throw new Error(`unknown match format: ${format}`);
    }
    const agents = (config.agents ?? []).map((a) =>
      typeof a === "string" ? { name: a } : a,
    );
    if (format === "comm-bat" && agents.length < 2) {
      throw new Error("comm-bat needs at least 2 agents");
    }
    if (format === "score-attack" && agents.length < 1) {
      throw new Error("score-attack needs at least 1 agent");
    }
    const agentNames = agents.map((a) => a.name);
    const fragLimit = config.fragLimit ?? 10;
    const timeLimitSec = config.timeLimitSec ?? 300;
    const episode = config.episode ?? 1;
    const level = config.level ?? 1;
    const difficulty = config.difficulty ?? "normal";
    const maxPlayers = config.maxPlayers ?? Math.max(2, agents.length);
    const startedAt = now().toISOString();
    const id = `match-${Date.now().toString(36)}`;

    const finish = async (scores, winner, endReason, observed) => {
      await endGame(format);
      return recordResult({
        id,
        format,
        agents: agentNames,
        config: { episode, level, difficulty, maxPlayers, fragLimit, timeLimitSec },
        winner,
        scores,
        observedScore: observed,
        startedAt,
        endedAt: now().toISOString(),
        endReason,
      });
    };

    if (format === "score-attack") {
      // Each agent plays its own run; highest score wins.
      const scores = {};
      for (const name of agentNames) {
        await tool("newGame", { episode, level, difficulty });
        const deadline = Date.now() + timeLimitSec * 1000;
        while (Date.now() < deadline) {
          await sleeper(tickMs);
          const reported = await collectScores([name]);
          if (typeof reported[name] === "number") scores[name] = reported[name];
        }
        const observed = await observedScore();
        if (typeof scores[name] !== "number" && typeof observed === "number") {
          scores[name] = observed;
        }
        try {
          await tool("quitGame", {});
        } catch {
          // best-effort
        }
      }
      const ranked = [...agentNames].sort(
        (a, b) => (scores[b] ?? -1) - (scores[a] ?? -1),
      );
      const winner =
        ranked.length > 0 &&
        typeof scores[ranked[0]] === "number" &&
        (ranked.length === 1 || scores[ranked[0]] > (scores[ranked[1]] ?? -1))
          ? ranked[0]
          : null;
      return finish(
        scores,
        winner,
        winner ? "time-limit" : "scores-unobserved",
        null,
      );
    }

    // comm-bat: one shared hosted game.
    await tool("hostMultiplayer", {
      mode: "comm-bat",
      maxPlayers,
      episode,
      level,
    });
    const deadline = Date.now() + timeLimitSec * 1000;
    let scores = {};
    let observed = null;
    let endReason = "time-limit";
    while (Date.now() < deadline) {
      await sleeper(tickMs);
      scores = await collectScores(agentNames);
      observed = await observedScore();
      const leader = agentNames.find(
        (name) => typeof scores[name] === "number" && scores[name] >= fragLimit,
      );
      if (leader) {
        endReason = "frag-limit";
        return finish(scores, leader, endReason, observed);
      }
    }
    const ranked = [...agentNames].sort(
      (a, b) => (scores[b] ?? -1) - (scores[a] ?? -1),
    );
    const winner =
      ranked.length > 0 &&
      typeof scores[ranked[0]] === "number" &&
      scores[ranked[0]] > (scores[ranked[1]] ?? -1)
        ? ranked[0]
        : null;
    if (!winner) endReason = "scores-unobserved";
    return finish(scores, winner, endReason, observed);
  }

  async function getLeaderboard() {
    const path = join(resultsDir, "leaderboard.json");
    if (!existsSync(path)) return { updatedAt: null, leaderboard: [] };
    return JSON.parse(await readFile(path, "utf-8"));
  }

  return { startMatch, loadResults, getLeaderboard, rebuildLeaderboard };
}

/** Render a leaderboard object as a standalone HTML page. */
export function renderLeaderboardHTML(board) {
  const rows = (board.leaderboard ?? [])
    .map(
      (entry) =>
        `<tr><td>${entry.agent}</td><td>${entry.wins}</td>` +
        `<td>${entry.matches}</td><td>${entry.bestScore}</td>` +
        `<td>${entry.lastPlayed ?? "—"}</td></tr>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<!-- SPDX-License-Identifier: MIT -->
<html lang="en"><head><meta charset="utf-8"><title>ROTT — Leaderboard</title>
<style>body{font-family:system-ui,sans-serif;background:#14161a;color:#e6e8eb;padding:16px}
table{border-collapse:collapse}td,th{border:1px solid #333842;padding:6px 12px;text-align:left}</style>
</head><body><h1>ROTT — Leaderboard</h1>
<p>Updated ${board.updatedAt ?? "never"}.</p>
<table><tr><th>Agent</th><th>Wins</th><th>Matches</th><th>Best score</th><th>Last played</th></tr>
${rows || '<tr><td colspan="5">No matches recorded yet.</td></tr>'}
</table></body></html>
`;
}
