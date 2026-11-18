<!-- SPDX-License-Identifier: MIT -->
# WebMCP + Agent UI overview

Phases 6, 7, and 8 of the ROTT fleet, built as MIT sidecar code. Nothing
here touches the GPL engine (`src/`), the WASM module, or its memory:
everything drives the game only through the published REST API,
WebSocket channels, and WebMCP tools.

## Layout (mirrors repo-relative paths)

- `packages/webmcp-generator/` — **Phase 6.** General-purpose
  OpenAPI 3.1 → WebMCP generator (TypeScript, no dependencies).
  `src/` (generator, runtime/JSON-RPC server, browser WebMCP
  registration, spec loader with a YAML subset parser), `tests/` (11
  tests), `examples/second-app/` (TaskBoard proof),
  `examples/rott-adapter/` (ROTT wiring + stand-in spec).
  `dist/` is the built output (`npm install && npm run build`).
- `ui/` — **Phase 7.** Agent launcher + chat steering UI (static
  HTML/vanilla JS/CSS + a tiny Node static server). Toggleable panel,
  custom/local agent registry, connection setup, launch controls, live
  chat steering, spectator view.
- `match-runner/` — **Phase 8.** Match runner (Node, no dependencies)
  with Comm-bat deathmatch + score/time attack, rule enforcement,
  JSONL results + leaderboard, and a mock-backend verification.
- `INTERFACES.md` — assumptions for lanes 1+2, grounded in lane 2's
  actual `docs/openapi.yaml` and `docs/websocket.md`.

## Verified (2026-11-18, Node v26.13.1 via nvm)

- `tsc --noEmit`: clean. `npm test`: **11/11 pass.**
- Second-app proof (`examples/second-app/verify.mjs`): **13/13 checks
  pass** — tools list and run from both the JSON and YAML specs.
- ROTT adapter against lane 2's real spec: **36 tools** generated and
  served over HTTP; a call with no sidecar running returns a clean
  network-error JSON, no crash.
- Match runner (`match-runner/verify.mjs`): **10/10 checks pass**
  against a scripted mock backend (Comm-bat frag-limit win, score-attack
  win, results + leaderboard, validation).
- UI static server: serves index/app.js/styles (200s, 404 for missing).
- `node --check` on every JS file: pass.

## Outstanding (needs lanes 1+2)

- Live-browser verification of WebMCP registration against the
  `w3c-oss/webmcp-polyfill` in Chrome (origin trial to Mar 30, 2027).
- Live two-agent matches and live UI driving against a running sidecar
  + game. The runner and UI are structurally verified only.
- Live check that `GET /api/v1/screen` and `game.chat` shapes match the
  docs they were built from.

## Notes

- Lane 2's spec landed mid-lane (47 KB, 36 operations). The generator's
  YAML subset parser was extended for it (block scalars, flow
  collections). The ROTT adapter prefers the lane-2 spec automatically;
  the stand-in spec is now only a fallback.
- Mirror Worker (`mw.py`) was degraded during this lane (HTTP 500
  Worker exceptions, including on trivial prompts, from ~21:33 UTC).
  One file (`src/types.ts`) was model-drafted; everything else was
  written directly. See `../LOG.md`.
