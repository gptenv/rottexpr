<!-- SPDX-License-Identifier: MIT -->
# WebMCP server choice: PR #1 `webmcp/` vs the generator-based adapter

**Status: decided — see [Recommendation](#recommendation) below.**
**Date:** 2026-11-18 (lane L48 of the 50-lane landing).
**Decides:** which WebMCP server is the Phase 6 path for `gptenv/rottexpr`.

There are two candidate ROTT WebMCP servers in the repo's history. They are
**not** two builds of the same thing: they expose different tool names, run
on different ports and paths, were generated against different specs, and
only one of them is actually built on the landed generator. This doc
compares them on the evidence, recommends one, and records what happens to
the other. It does not modify either candidate — PR #1 and its branch are
untouched by this lane.

## The two candidates

### A — PR #1's standalone server (`webmcp/`)

- **Where:** open PR #1, branch `lane/L39-gen-rott-hookup`, by defcron,
  2026-11-18T22:22Z. Title: "Generate ROTT WebMCP server from the OpenAPI
  spec (coordinator-regenerated)".
- **Files:** `webmcp/rott-server.mjs` (the server), `webmcp/mock-rest.mjs`
  (a mock sidecar on `:8787`), `webmcp/verify.mjs` (a harness booting the
  mock plus the server and exercising every tool).
- **How it works:** `rott-server.mjs` loads `../docs/openapi.yaml`, builds
  a tool server, and serves HTTP on port `3000` (env `PORT`):
  `GET /webmcp/tools`, `POST /webmcp/call`, `GET /webmcp/client.js`
  (a browser script for the page), `GET /` (tool list as JSON).
- **Tool surface claimed:** 28 tools. The PR body and `verify.mjs` report
  `node verify.mjs` as **39 passed, 0 failed** (28 tool calls plus negative
  cases: unknown tool → 500, missing required input → 500, REST 404 → 500),
  run in a staged repo layout against the mock sidecar.
- **Tool names (from `verify.mjs`):** `getHealth`, `getState`, `getScreen`,
  `postInputKey`, `postInputMouse`, `postInputText`, `postInputSequence`,
  `getConfig`, `updateConfig`, `getConfigSection`, `listSaves`, `saveGame`,
  `loadGame`, `playDemo`, `stopDemo`, `listMods`, `loadMod`, `getMod`,
  `unloadMod`, `applyRecodeScript`, `getRecodeStatus`,
  `hotSwapRecodeModule`, `createMatch`, `listMatches`, `getMatch`,
  `startMatch`, `stopMatch`, `getLeaderboard`.

### B — The generator-based adapter (L27)

- **Where:** `packages/webmcp-generator/examples/rott-adapter/` (lane L27
  of the 50-lane landing; PR title "Add ROTT WebMCP adapter
  (generator-based, 36 tools)").
- **Files:** `rott-server.mjs` (thin adapter), `README.md`,
  `rott-openapi.example.json` (a 15-operation stand-in spec, used only as
  a fallback), `webmcp-page-snippet.mjs` (browser registration docs).
- **How it works:** `rott-server.mjs` calls `generateServerFromFile()` from
  the **built** generator (`../../dist/index.js`), pointed at the sidecar
  REST API (`ROTT_SIDECAR_URL`, default `http://localhost:8787`), and
  listens on port `3200` (env `WEBMCP_PORT`). Endpoints: `GET /tools`,
  `POST /tools/call`, `POST /` (JSON-RPC 2.0 `tools/list` / `tools/call`).
  `webmcp-page-snippet.mjs` documents registering the same generated tools
  in the browser with `navigator.modelContext` (native WebMCP or the
  `w3c-oss/webmcp-polyfill`).
- **Tool surface verified:** **36 tools**, generated from lane-2's real
  spec (`docs/openapi.yaml`, OpenAPI 3.1.0, "ROTT Sidecar API" v1.0.0).
  Verified 2026-11-18 with
  `node dist/cli.js --spec <lane-2 openapi.yaml> --base-url
  http://localhost:8787 --list-only` → `toolCount: 36`.
- **Tool names (the spec's `operationId`s, verbatim):** `getHealth`,
  `getState`, `getScreen`, `sendKey`, `sendMouse`, `sendText`,
  `sendInputSequence`, `getConfig`, `putConfig`, `getConfigSection`,
  `listSaves`, `saveGame`, `loadGame`, `playDemo`, `stopDemo`, `listMods`,
  `loadMod`, `getMod`, `unloadMod`, `reloadMod`, `listScripts`,
  `registerScript`, `getScript`, `unregisterScript`, `reloadScript`,
  `swapWasm`, `getGameInfo`, `newGame`, `pauseGame`, `resumeGame`,
  `quitGame`, `hostMultiplayer`, `joinMultiplayer`, `leaveMultiplayer`,
  `listChat`, `sendChat`.
- **Generator provenance:** the generator itself
  (`packages/webmcp-generator/`) is general-purpose — no ROTT-specific
  code — and is proven on a second app, the TaskBoard proof
  (`examples/second-app/`, `node verify.mjs` 13/13, lane L26), with its own
  test suite at 11/11 (lane L25). That is exactly what AGENTS.md Phase 6
  requires: build the generator first, prove it on a second app, then hook
  it up to ROTT.

## How they differ

| | A — PR #1 `webmcp/` | B — L27 adapter |
|---|---|---|
| Spec it serves | A 28-operation spec with match endpoints (`createMatch`, `listMatches`, `getMatch`, `startMatch`, `stopMatch`, `getLeaderboard`) and recode endpoints (`applyRecodeScript`, `getRecodeStatus`, `hotSwapRecodeModule`) | Lane-2's real spec, `docs/openapi.yaml`: 36 operations, no match endpoints |
| Tool names | Its own names (`postInputKey`, `updateConfig`, `applyRecodeScript`, …) — **not** the spec's `operationId`s | The spec's `operationId`s, verbatim (`sendKey`, `putConfig`, `registerScript`, `swapWasm`, …) |
| Generator dependency | Imports `createToolServer`, `loadSpec`, `createWebMcpHttpHandler`, `emitBrowserScript` from `../packages/webmcp-generator/src/index.js` | Calls `generateServerFromFile()` from the built `../../dist/index.js` |
| Does that API exist? | **No.** Those four import names occur **0 times** in the landed generator's `src/` and `dist/` (verified by grep, 2026-11-18). The generator's actual exports are `generateServer`, `generateServerFromFile`, `generateServerFromText`, plus `loadSpecFile` / `loadSpecFromText`. It also imports TypeScript **source** (`src/index.js`), not the built `dist/` that L19 lands | Yes — the exact function the generator ships |
| Port / routes | `:3000`, `/webmcp/tools`, `/webmcp/call`, `/webmcp/client.js`, `/` | `:3200`, `/tools`, `/tools/call`, `/` (JSON-RPC) |
| Browser WebMCP | Serves a `client.js` browser script | Registers via `navigator.modelContext` (native or polyfill), documented in `webmcp-page-snippet.mjs` |
| Mock + verify harness | Yes: `mock-rest.mjs` + `verify.mjs` (39 passed claimed) | No mock; relies on the generator's tests (11/11) and the TaskBoard proof (13/13) |
| Spec dependency on disk | `../docs/openapi.yaml` — **not on `master` yet** (L06 lands it); same gap as B, but see below | Prefers the real spec; falls back to the 15-op stand-in example with a stdout warning. Note: the fallback lookup still contains a hardcoded absolute workspace path to lane-2's output — a wart to fix by resolving the spec relative to the repo root once L06 lands (see Open issues) |
| Matches | Match tools built in (`createMatch` …) | No match tools — matches live in the match runner (L29), not the sidecar REST API, so the spec has no match operations to generate from |

The decisive discrepancy is the first two rows together: **A's 28-tool
surface cannot be produced from the spec that actually exists.** The real
`docs/openapi.yaml` has 36 `operationId`s and no match or recode endpoints
at all, while A's names (`postInputKey` vs `sendKey`, `updateConfig` vs
`putConfig`, `applyRecodeScript` vs `registerScript`,
`hotSwapRecodeModule` vs `swapWasm`) do not appear in it. A was generated
against a different, earlier or parallel spec — one that described match
and recode endpoints the sidecar never implemented. Its "39 passed"
verification is therefore a verification **against the mock and that other
spec**, in a staged layout; it does not establish that A drives the real
sidecar, and it is not reproducible from the repo as landed: on a checkout
of `master` + PR #1 alone, `rott-server.mjs` fails at import time (the
imported names do not exist, and it imports TS source rather than built
output), and the spec it loads is absent until L06 merges.

B has the opposite profile: nothing about it is a snapshot. Every tool it
serves is derived at startup from the spec on disk, so when the spec
changes the tools change with it — no regeneration step, no drift between
the REST API and the tools an agent sees. Its 36-tool count was
re-verified against the real spec during this lane's work.

## Pros and cons

### A — PR #1 `webmcp/`

**Pros**

- **Self-contained demo:** mock sidecar + verify harness means the server
  can be exercised end to end without a running game, sidecar, or WASM
  build. That is genuinely useful as a test fixture.
- **Match tools included:** it is the only candidate that exposes match
  operations (`createMatch`, `startMatch`, `stopMatch`, `getLeaderboard`)
  as tools. If matches are ever meant to be drivable through WebMCP, that
  surface has to come from somewhere.
- **Browser script served:** `GET /webmcp/client.js` gives the game page a
  one-URL way to fetch the client.
- **Already open and reviewed in outline:** it predates the 50-lane
  landing and its verification claim (39 passed) is on the record.

**Cons**

- **Not actually generated by the landed generator.** Its imports name an
  API (`createToolServer`, `createWebMcpHttpHandler`, `emitBrowserScript`,
  `loadSpec`) that does not exist in `packages/webmcp-generator/` (0
  occurrences in `src/` + `dist/`), and it imports TS source instead of
  the built `dist/`. As landed, it cannot start.
- **Generated against the wrong spec.** 28 tools, different names, match
  and recode endpoints the real spec does not have. Merging it would put a
  second, incompatible tool vocabulary into the repo: an agent calling
  `postInputKey` against B's server (or `sendKey` against A's) gets an
  unknown-tool error.
- **Hand-maintained surface.** Because its tools do not come from the spec
  on disk, every spec change needs a regeneration — and the regeneration
  that produced it is not reproducible from the repo (there is no
  generator command in the repo that emits those names).
- **Two servers problem.** If both A and B merge, the repo has two ROTT
  WebMCP servers on different ports (`:3000` vs `:3200`) with different
  routes and different tools. Every consumer — the agent UI (L28), the
  match runner (L29), the getting-started docs (L46) — would have to pick
  one, and the pick would be arbitrary. That is the opposite of Phase 6's
  "the ROTT WebMCP server serves the generated tools" (singular).

### B — L27 generator-based adapter

**Pros**

- **Is what AGENTS.md Phase 6 orders:** a general-purpose generator,
  proven on a second app, with the ROTT server autogenerated from the
  OpenAPI spec. The spec is the single source of truth for REST and for
  tools, so they cannot drift apart.
- **Reproducible and verified against the real spec:** 36 tools,
  re-verified this lane with `--list-only`; tool names are the spec's
  `operationId`s, so the REST docs, the sidecar handlers (L10), and the
  tools all name the same operations.
- **One executor, two transports:** the same generated executor backs the
  Node JSON-RPC/REST server and the in-browser `navigator.modelContext`
  registration, so an agent in the page and an agent over HTTP see the
  same tools with the same behaviour.
- **Reusable beyond ROTT:** the generator is a standalone package; the
  TaskBoard proof shows any OpenAPI spec gets a server the same way.

**Cons**

- **No mock sidecar, no verify harness.** A cannot be exercised without a
  live sidecar; its failure mode with no sidecar running is a clean
  network-error JSON per tool call, not a mock. (The generator's own
  tests and the TaskBoard proof cover the machinery, not a ROTT-shaped
  mock.)
- **No match tools.** Matches are not REST operations in the spec, so the
  generator cannot emit them. If match control belongs in WebMCP, the
  spec (and the sidecar) must gain match endpoints first — or the match
  runner must expose its own tools.
- **Spec-resolution wart:** the adapter still falls back to a hardcoded
  absolute workspace path for lane-2's spec output, and to the 15-op
  stand-in when that is absent. Until that is resolved relative to the
  repo root, running it outside the lane-2 workspace can silently serve
  the stand-in's 15 tools instead of the real 36. (See Open issues.)
- **Live-browser verification outstanding:** the polyfill /
  `navigator.modelContext` registration path is structurally verified in
  Node only (`detectWebMCP()` → `"unavailable"`, all tools skipped by
  design). No Chrome run has registered the tools in a real page yet —
  the same gap the L34 Chrome checklist exists to close.

## Recommendation

**Adopt B — the L27 generator-based adapter — as the Phase 6 path. Do not
merge PR #1 as the WebMCP server.**

Reasons, in order:

1. **It is the only candidate that satisfies the Phase 6 order as written.**
   AGENTS.md Phase 6 says the server is *autogenerated from the OpenAPI
   spec* by a *general-purpose generator proven on a second app*. B is
   that; A is a snapshot generated against a spec that no longer exists
   (if it ever did in-repo), by a generator API that does not exist.
2. **It is the only candidate that runs against the repo as landed.** B's
   36 tools were re-verified against the real spec this lane. A fails at
   import time on the landed generator and loads a spec that is not on
   `master` yet.
3. **One tool vocabulary.** REST, WebSocket, and WebMCP should name the
   same operations. Only B guarantees that, because it derives the names
   from the spec. Merging A would fork the vocabulary (`postInputKey` vs
   `sendKey`) and force every consumer to choose.
4. **A's real value is separable from its server.** Its mock sidecar and
   verify harness are useful — as a test fixture, not as the server. That
   value can be salvaged without merging the server (see below).

**What happens to PR #1:** do not merge it as-is. The recommended
disposition, for the user/maintainer to confirm, is:

- **Close PR #1 without merging** once L27 lands, with a pointer to this
  doc; **or**, if the mock/verify harness is wanted, salvage
  `mock-rest.mjs` + `verify.mjs` into a clearly-labelled test fixture
  (e.g. under the generator's tests, or a `webmcp/` fixture dir that is
  **not** a second server) — rewritten against the real 36-operation spec
  and the real generator API, and renamed so nobody mistakes it for the
  server. That salvage is follow-up work, not part of this lane, and it
  must not reintroduce a second server on `:3000`.
- Either way, **do not run both servers.** One ROTT WebMCP server:
  the L27 adapter on `:3200`, serving the generated tools.

## When to use which (the short version)

- **Building, documenting, or driving the game through WebMCP:** use B,
  the L27 adapter (`packages/webmcp-generator/examples/rott-adapter/`,
  port `3200`). Its tools are the spec's operations; if an operation is
  missing, fix the spec / sidecar, not the adapter.
- **Testing tool-call plumbing without a game or sidecar:** that is the
  one job A was good at — but use A's *pattern* (mock REST + harness),
  rewritten for the real spec, not A's code as landed. Until such a
  fixture exists, the generator tests (L25, 11/11) and the TaskBoard
  proof (L26, 13/13) are the offline verification available.
- **Match control through WebMCP:** neither candidate does this against
  the real spec today. Do not reach for A to get it — its match tools
  call REST endpoints the sidecar does not implement. Add match
  operations to the spec + sidecar first, then they appear as generated
  tools in B for free.
- **In-browser agents (page + polyfill):** use B's
  `webmcp-page-snippet.mjs` registration via `navigator.modelContext`.
  A's `client.js` endpoint serves a script built on the non-existent
  generator API and should not be used.

## Open issues / follow-ups (not decided here)

1. **Adapter spec resolution (B):** replace the hardcoded absolute
   workspace path and the stand-in fallback with a repo-relative lookup
   (`docs/openapi.yaml` from the repo root, env `ROTT_OPENAPI_SPEC`
   override), and fail loudly instead of silently serving the 15-op
   stand-in when the real spec is absent.
2. **Match tools:** decide whether match control belongs in the WebMCP
   surface. If yes, add match operations to `docs/openapi.yaml` and the
   sidecar; B then generates them with no adapter change.
3. **Mock harness salvage:** if PR #1's mock + verify pattern is wanted,
   rewrite it against the real spec / real generator API as a test
   fixture (not a server). Owner: whoever picks it up after L27 lands.
4. **Live-browser verification:** register the generated tools in Chrome
   via the polyfill / origin trial and record the result (L34's
   checklist). Outstanding for both candidates; B's registration path is
   the one to verify.
5. **PR #1 disposition:** close-with-pointer vs salvage needs the
   maintainer's call — this doc recommends, it does not close the PR.

## Evidence (how the claims above were checked, 2026-11-18)

- PR #1 read via the GitHub connector: `list_pull_requests` (open) —
  PR #1 (`lane/L39-gen-rott-hookup`, head `cc54a64e…`, 2026-11-18T22:22Z)
  and PR #2 (L01) open; no PR covers `docs/webmcp-server-choice.md`.
  `get_file_contents` on `webmcp/rott-server.mjs` and
  `webmcp/verify.mjs` at `lane/L39-gen-rott-hookup` (server SHA
  `6ec17390…`, verify SHA `864b786b…`); PR #1 body for the 39-passed
  claim and the file list. (`mock-rest.mjs` was not re-fetched: a
  follow-up read hit GitHub rate limiting (HTTP 429) and was not
  retried; its role as the mock sidecar on `:8787` is taken from the PR
  body and `verify.mjs`, which spawns it.)
- `docs/openapi.yaml` on `master`: `get_file_contents` → not found
  (L06 has not landed it yet).
- Lane-2 spec: 36 `operationId`s by grep; no match endpoints.
- Generator API: `grep -c` for `createToolServer`,
  `createWebMcpHttpHandler`, `emitBrowserScript` across the landed
  generator `src/` + `dist/` → **0 matches**; `dist/index.js` exports
  only `generateServer`, `generateServerFromFile`,
  `generateServerFromText` (plus `loadSpecFile` / `loadSpecFromText` in
  `loadSpec.js`).
- L27 36-tool claim re-verified: `node
  packages/webmcp-generator/dist/cli.js --spec <lane-2 openapi.yaml>
  --base-url http://localhost:8787 --list-only` (Node v26.13.1 via nvm)
  → `"toolCount": 36`, `"name": "ROTT Sidecar API"`.
- Mirror Worker drafting for this doc failed: `mw.py chat --model
  gpt-5-6-thinking --conversation-id rott-lane-48` returned HTTP 500 /
  Cloudflare 1101 ("Worker threw exception", marked non-retryable), so
  this doc is self-authored from the evidence above; no model draft was
  used.
- **Not verified here:** PR #1's `verify.mjs` was not re-run (it needs
  its staged layout with the other spec and the generator API it
  imports); no live-browser WebMCP registration was attempted (generic
  subagents cannot drive a live browser); no Chrome run of either
  server. Those gaps are stated, not papered over.

## Licensing

This doc is MIT sidecar documentation. It touches no `src/` file and no
GPL-covered file, and it does not modify PR #1, its branch, or any
candidate server. Part of the 50-lane ROTT landing (lane L48/50).
