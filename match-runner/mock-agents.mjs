// SPDX-License-Identifier: MIT
/**
 * Mock WebMCP tool backend for match-runner verification.
 *
 * Implements just enough of the ROTT tools (hostMultiplayer, newGame,
 * getState, listChat, sendChat, quitGame, leaveMultiplayer, pauseGame,
 * resumeGame) as an in-memory game so the runner can be exercised
 * end-to-end without a live sidecar or game. Scripted "agents" score
 * frags on a schedule and report `score: <n>` through the mock chat,
 * exactly the way real agents would through the published tools.
 */
export function createMockBackend() {
  const chat = [];
  const state = {
    status: "menu",
    bridgeConnected: true,
    episode: 1,
    level: 1,
    difficulty: "normal",
    health: 100,
    score: 0,
    screenHash: "mock",
    updatedAt: new Date().toISOString(),
  };
  // Scripted scoring: in comm-bat, agent-1 scores every getState poll
  // and agent-2 every second poll. In score-attack, each newGame starts
  // a new run (run 0 = agent-1, run 1 = agent-2, by the script); the
  // first run scores 2 per poll and later runs 1 per poll, so the runs
  // differ. The mock advances only when the runner polls state.
  const frags = { "agent-1": 0, "agent-2": 0 };
  let polls = 0;
  let running = false;
  let mode = null;
  let runIndex = -1;

  function reportScore(name) {
    chat.push({
      from: name,
      text: `score: ${frags[name]}`,
      to: null,
      ts: new Date().toISOString(),
    });
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case "hostMultiplayer":
        running = true;
        mode = "comm-bat";
        state.status = "playing";
        state.episode = args.episode ?? 1;
        state.level = args.level ?? 1;
        return { ok: true, status: 200, data: { ...state } };
      case "newGame":
        running = true;
        mode = "score-attack";
        runIndex++;
        state.status = "playing";
        state.episode = args.episode ?? 1;
        state.level = args.level ?? 1;
        state.difficulty = args.difficulty ?? "normal";
        state.score = 0;
        frags["agent-1"] = 0;
        frags["agent-2"] = 0;
        return { ok: true, status: 200, data: { ...state } };
      case "getState": {
        if (running) {
          polls++;
          if (mode === "score-attack") {
            const name = runIndex === 0 ? "agent-1" : "agent-2";
            frags[name] += runIndex === 0 ? 2 : 1;
            reportScore(name);
            state.score = frags[name];
          } else {
            frags["agent-1"]++;
            if (polls % 2 === 0) frags["agent-2"]++;
            // Agents report through chat, as real agents would.
            reportScore("agent-1");
            reportScore("agent-2");
            state.score = frags["agent-1"] + frags["agent-2"];
          }
        }
        return { ok: true, status: 200, data: { ...state } };
      }
      case "listChat":
        return { ok: true, status: 200, data: [...chat] };
      case "sendChat":
        chat.push({
          from: args.from ?? "unknown",
          text: args.text ?? "",
          to: args.to ?? null,
          ts: new Date().toISOString(),
        });
        return { ok: true, status: 200, data: { accepted: true } };
      case "quitGame":
      case "leaveMultiplayer":
        running = false;
        state.status = "menu";
        return { ok: true, status: 200, data: { ...state } };
      case "pauseGame":
        state.status = "paused";
        return { ok: true, status: 200, data: { ...state } };
      case "resumeGame":
        state.status = "playing";
        return { ok: true, status: 200, data: { ...state } };
      default:
        return {
          ok: false,
          status: 404,
          error: { code: "unknown_tool", message: `unknown tool: ${name}` },
        };
    }
  }

  return { callTool, chat, state, frags };
}
