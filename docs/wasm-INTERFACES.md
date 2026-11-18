<!-- SPDX-License-Identifier: MIT -->
# INTERFACES.md — lane 1 (WASM port) assumptions for the other lanes

Date: 2026-11-18. These are assumptions, not verified facts, except where
a verification is cited. If an assumption is wrong, the owning lane should
say so and lane 1 will adjust the build config / demo shell (never `src/`).

## Repo layout this lane assumes (for the parent / merge step)

All lane-1 outputs mirror repo-relative paths and belong at the repo root:

| This lane's output | Repo destination |
|---|---|
| `outputs/Makefile.emcc` | `Makefile.emcc` (repo root) |
| `outputs/.github/workflows/wasm.yml` | `.github/workflows/wasm.yml` |
| `outputs/web/` | `web/` (demo page shell) |
| `outputs/compat/emscripten/execinfo.h` | `compat/emscripten/execinfo.h` |
| `outputs/BRIDGE-CONTRACT.md` | `docs/bridge-contract.md` (suggested; or repo-root `BRIDGE-CONTRACT.md`) |
| `outputs/NATIVE-BUILD.md` | `docs/native-build.md` (suggested; evidence of Phase 1) |
| `outputs/emsdk-setup.md` | `docs/emsdk-setup.md` (suggested) |
| `outputs/INTERFACES.md` | this file (lane record; not necessarily for the repo) |
| `outputs/native-menu-screenshot.png` | evidence only; do not commit to the repo |

Shareware data (`data/shareware/`) is NOT in this lane's outputs: it is
already decided (repo AGENTS.md) to ship in-repo, but committing 6.4 MB
of game data is a merge decision for the parent, not this lane. The files
are HUNTBGIN.RTC/.RTL/.WAD, DEMO1_3.DMO…DEMO4_3.DMO, REMOTE1.RTS,
sourced from the 1.3 shareware distribution `1rott13.zip`
(gamers.org mirror of ftp.3drealms.com). HUNTBGIN.WAD md5:
`37793500e3b1de2125a98604b69838e3`. VENDOR.DOC (the shareware
distribution permission) was kept alongside the data during local
testing, in the lane dir only.

## Assumptions for lane 2 (sidecar / bridge)

1. The bridge implements against `BRIDGE-CONTRACT.md` v1 only. Canvas
   id `rott-canvas`; `window.ROTT` methods as documented.
2. The bridge runs in the same page as the demo shell (same origin).
   It does not get its own WASM instance.
3. Save/config reads go through a page-side helper lane 2 writes; lane 1
   guarantees the files exist at `/home/web_user/.rott/` (shareware) and
   that IDBFS is mounted before `main()` runs. Lane 2 must handle the
   up-to-30 s persist delay (see BRIDGE-CONTRACT §3).
4. Mouse-look via synthetic events is best-effort (pointer lock needs a
   real user gesture). Keyboard driving always works. Lane 2 should
   design gameplay driving around keys first, mouse second.
5. Screenshots require a `requestAnimationFrame` callback
   (preserveDrawingBuffer=false). Lane 2 must not screenshot from a
   timer and expect a fresh frame.
6. The demo shell has no server component. If lane 2's server needs to
   serve `web/` + `build/wasm/`, it must serve them from one directory
   layout: either repo-root style (`/web/index.html` + `/build/wasm/`)
   or flat (`/index.html` + `/rott.js` next to it). `web/app.js`
   auto-detects both. No COOP/COEP headers are needed (single-threaded
   build); do not add them unless threads are introduced later.

## Assumptions for lane 3 (WebMCP generator)

1. The OpenAPI spec (Phase 4) will describe operations that map to
   `window.ROTT` calls + file reads + menu navigation — nothing that
   needs engine internals. If an operation cannot be expressed that way,
   it does not exist; the generator must not invent engine hooks.
2. No WebMCP work depends on this lane beyond the bridge contract.

## Assumptions about the engine (verified where noted)

- **Verified**: main loop is a blocking `while (1)` in `src/rt_main.c`
  (line 1056) inside `main()`; hence ASYNCIFY, not `emscripten_set_main_loop`.
- **Verified**: saves/config live under `$HOME/.rott/` (shareware) and
  `$HOME/.rott/darkwar/` (registered) — `src/dosutil.c` `setup_homedir()`.
  Files observed on a native run: `config.rot`, `sound.rot`,
  `battle.rot`, `scores.rot` (a `VENDOR.DOC` also appeared in `.rott/`;
  which component placed it there was not investigated).
- **Verified**: native shareware build runs and renders (Xvfb screenshot
  in this lane's outputs). Native default (registered) build compiles
  (0 errors) but was only run with shareware data, where it correctly
  complains `Could not find User file 'DARKWAR.WAD'` — registered data
  was never present and never will be in this lane.
- **Assumed, not verified**: SDL_mixer under Emscripten produces audio
  through WebAudio with no extra flags beyond `-sUSE_SDL_MIXER=2`.
  Needs a live Chrome check.
- **Assumed, not verified**: the game's save-file format and the 14
  save-slot naming (`SAVEGAM?.ROT`) — the slot count (14) is from
  `src/_rt_menu.h` (`NUMSAVEGAMES 14`); exact filenames were not
  confirmed by a save/load cycle (no interactive run was possible
  headless). Lane 2 should confirm filenames on first interactive use.
- **Assumed, not verified**: demo playback (`DEMO*_3.DMO`) works in the
  WASM build; the files are preloaded but attract-mode playback was not
  exercised.
- **Assumed**: 256 MB initial heap (`-sINITIAL_MEMORY=256MB`) is enough;
  the native run reported `Z_INIT: 899950000 bytes` of zone memory
  requested, which is a virtual arena size, not resident use — but if
  the WASM build throws on allocation, raise `INITIAL_MEMORY` (with
  `ALLOW_MEMORY_GROWTH=1` already on, growth should cover it at a perf
  cost). This is the first knob to turn if Chrome reports OOM.

## Known limitations of this lane's deliverables

- No live Chrome check was possible (no browser in this environment).
  The WASM build is verified to the link step only (see NATIVE-BUILD.md).
- The `execinfo.h` shim means WASM crash stack dumps are empty
  (`backtrace()` returns 0 frames). Browser devtools remain the crash
  debugging route.
- The CI workflow has no headless runtime test (no browser in CI
  without extra setup). Adding a Playwright/puppeteer smoke test is a
  follow-up, not in this lane.
- `Makefile.emcc` compiles all engine + audiolib sources in a single
  `emcc` invocation (no per-file objects, no caching). It is correct
  and simple; it is not fast. A follow-up may split it into object
  rules if CI build time hurts.
- The GitHub Pages deploy job in `wasm.yml` is intentionally commented
  out until hosting is agreed.
