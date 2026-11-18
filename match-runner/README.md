<!-- SPDX-License-Identifier: MIT -->
# Match runner (Phase 8)

Runs ROTT agent matches through the published WebMCP tools only.

## Run a match (programmatic)

```js
import { generateServerFromFile } from "../packages/webmcp-generator/dist/index.js";
import { createMatchRunner } from "./match-runner.mjs";

const server = generateServerFromFile(
  "/home/hatch/workspace/rott-fleet/lane-2-sidecar/outputs/docs/openapi.yaml",
  { baseUrl: "http://localhost:8787" },
);
const runner = createMatchRunner({
  callTool: (name, args) => server.executor.callTool(name, args),
  resultsDir: "./results",
});

const result = await runner.startMatch({
  format: "comm-bat",            // or "score-attack"
  agents: [{ name: "agent-1" }, { name: "agent-2" }],
  episode: 1,
  level: 1,
  difficulty: "normal",
  maxPlayers: 4,
  fragLimit: 10,
  timeLimitSec: 300,
});
console.log(result.winner, result.scores);
```

## Formats

- **Comm-bat** (default, first): one hosted deathmatch
  (`hostMultiplayer`, mode `comm-bat`). Ends when an agent reaches the
  frag limit or the time limit expires. Winner: highest reported score.
- **Score attack** (second): each agent plays its own single-player run
  (`newGame`) of the same episode/level/difficulty for the same time
  limit. Highest score wins.

## Rules, enforced by the runner

- Time limit: the match ends and the game is quit when it expires.
- Frag limit (Comm-bat): the match ends as soon as any agent's reported
  score reaches it.
- Agents play only through WebMCP tools. The runner itself only calls
  tools (via the injected `callTool`); it has no REST/WebSocket access
  of its own and no backdoor state access.

## Scores — the honest limitation

The bridge observes one game state, not per-agent frag counts, so there
is no per-agent score in the published interfaces. Agents report their
score through chat (`sendChat` with text `score: <n>`, `from` = agent
id); the runner reads them back with `listChat` and cross-checks
against the observable `getState().score` when non-null. A match whose
agents never report a score is recorded with `winner: null` and
`endReason: "scores-unobserved"` — never invented.

## Results and leaderboard

- `<resultsDir>/results.jsonl` — one JSON result per match.
- `<resultsDir>/leaderboard.json` — aggregated wins / matches / best
  score per agent, rebuilt after every match.
- `renderLeaderboardHTML(board)` — standalone leaderboard page.

## Verification

```sh
node verify.mjs   # 10 checks against a scripted mock tool backend, exit 0
```

The mock (`mock-agents.mjs`) implements the ROTT tools in memory with
scripted agents that score and report through mock chat. **Live
two-agent matches against a real sidecar + game are outstanding**
(lanes 1+2 running); the runner is verified structurally, not live.
