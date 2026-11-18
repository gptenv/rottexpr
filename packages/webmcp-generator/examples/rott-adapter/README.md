<!-- SPDX-License-Identifier: MIT -->
# ROTT adapter

Wires the general-purpose generator to the ROTT sidecar's OpenAPI spec
and serves the generated WebMCP tools.

## Run it

```sh
cd packages/webmcp-generator
npm install && npm run build
node examples/rott-adapter/rott-server.mjs [spec-path] [port]
# env: ROTT_OPENAPI_SPEC (spec path), ROTT_SIDECAR_URL (default
# http://localhost:8787), WEBMCP_PORT (default 3200)
```

## Spec resolution

1. `argv[2]` or `ROTT_OPENAPI_SPEC`, if given.
2. Lane 2's real spec:
   `/home/hatch/workspace/rott-fleet/lane-2-sidecar/outputs/docs/openapi.yaml`
   — **this is what is used now** (found 2026-11-18, 47 KB, OpenAPI
   3.1.0, "ROTT Sidecar API" v1.0.0).
3. Fallback: the stand-in `rott-openapi.example.json` (15 operations,
   derived from the Phase 4 endpoint list in `AGENTS.md`), with a
   warning on stdout. The stand-in exists only so the adapter was
   testable before lane 2's spec landed; it is not the source of truth.

## Verified (2026-11-18, Node v26.13.1)

- `node dist/cli.js --spec <lane-2 openapi.yaml> --base-url
  http://localhost:8787 --list-only` → **36 tools** (`getHealth`,
  `getState`, `getScreen`, `sendKey`, `sendMouse`, `sendText`,
  `sendInputSequence`, `getConfig`, `putConfig`, `getConfigSection`,
  `listSaves`, `saveGame`, `loadGame`, `playDemo`, `stopDemo`,
  `listMods`, `loadMod`, `getMod`, `unloadMod`, `reloadMod`,
  `listScripts`, `registerScript`, `getScript`, `unregisterScript`,
  `reloadScript`, `swapWasm`, `getGameInfo`, `newGame`, `pauseGame`,
  `resumeGame`, `quitGame`, `hostMultiplayer`, `joinMultiplayer`,
  `leaveMultiplayer`, `listChat`, `sendChat`).
- `rott-server.mjs` with no args serves those 36 tools at
  `GET /tools` on port 3200. A `tools/call` with no sidecar running
  returns a clean network-error JSON (`tool "getHealth" network error
  calling http://localhost:8787/health: fetch failed`) — no crash.
- The generator's YAML subset parser was extended for this spec: it now
  handles literal/folded block scalars and flow collections of scalars
  (`required: [code, message]`, `enum: [easy, normal, hard, very-hard]`),
  after the real spec exposed both constructs.

## Browser / polyfill

`webmcp-page-snippet.mjs` documents how the ROTT page registers the
same generated tools with `navigator.modelContext` (native WebMCP or
the `w3c-oss/webmcp-polyfill`). **Live-browser verification against
the polyfill is outstanding** — this lane has no browser. In Node,
`detectWebMCP()` correctly returns `"unavailable"` and
`registerToolsWithWebMCP()` reports every tool skipped, which is the
designed no-WebMCP behaviour.
