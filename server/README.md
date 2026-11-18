<!-- SPDX-License-Identifier: MIT -->
# ROTT sidecar (REST + WebSocket)

MIT sidecar server + page-side bridge. Drives the ROTT game only through
player-layer interfaces (DOM input, screenshots, save/config/data files,
existing network protocol). Never modifies the engine, never reads WASM
memory, never claims runtime C recompilation.

## Layout (mirrors repo-relative paths)

- `docs/openapi.yaml` — the source of truth: 30 paths, 36 operations.
- `docs/websocket.md` — channels `game.state`, `game.events`,
  `game.deltas`, `game.chat`; messages `{type, seq, ts, payload}`.
- `server/` — TypeScript sidecar (Node 26 via nvm).
  - `package.json`, `tsconfig.json`
  - `src/types.ts` — shared types (mirror the OpenAPI schemas) + bridge
    and WebSocket protocols.
  - `src/state.ts` — observable-state store + delta diffing.
  - `src/bridge.ts` — `/bridge` control-channel client (sidecar side).
  - `src/config.ts` — config store (video/audio/controls/difficulty/options).
  - `src/mods.ts` — data-driven mod registry (+ WAD overlay file reads).
  - `src/scripts.ts` — hot-reloadable script-layer registry.
  - `src/handlers.ts` — one method per OpenAPI operationId; shared by
    REST and WebSocket (same handlers, different transport).
  - `src/ws.ts` — `/ws` hub: subscribe, broadcast, bidirectional commands.
  - `src/server.ts` — HTTP routing, WS upgrade routing, observe tick
    (500 ms) + state tick (2 s).
  - `src/data/` (created at runtime) — persisted config/mods/scripts
    JSON; WAD overlays live in `src/data/mods/<id>/`.
- `bridge/rott-bridge.js` — plain-JS page bridge. Include it in the game
  page; it auto-connects to `ws://localhost:8787/bridge`.
- `mods/example-mod/` — example data-driven mod (`mod.json` + README).
- `INTERFACES.md` — assumptions for the other lanes (lane 1's
  BRIDGE-CONTRACT.md did not exist yet when this was written).

## Run it

```sh
source ~/.bashrc   # nvm Node 26 wins
cd server
npm install        # rolling targets: ws, typescript, @types/*
npm run build
npm start          # http://localhost:8787
```

Then open the game page (with `bridge/rott-bridge.js` included) and:

```sh
curl http://localhost:8787/health
curl http://localhost:8787/api/v1/state
curl -X POST http://localhost:8787/api/v1/input/key \
  -H 'content-type: application/json' \
  -d '{"key":"ArrowUp","action":"press"}'
```

## Verification

See the lane delivery report. Type-checked with `tsc --noEmit`,
bridge checked with `node --check`, spec validated as YAML, and every
spec operation cross-checked against a handler in `handlers.ts`.
Live game driving is integration-outstanding: it needs lane 1's WASM
build + game page.
