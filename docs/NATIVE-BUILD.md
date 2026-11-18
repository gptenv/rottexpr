<!-- SPDX-License-Identifier: MIT -->
# NATIVE-BUILD.md — Phase 1 verification report (lane 1)

Date: 2026-11-18. Repo: `gptenv/rottexpr`, cloned at head `a5f3e1b`
("Update AGENTS.md"). All commands run in the lane's scratch clone
(`lane-1-wasm/repo/`); `src/` was never edited.

## Environment

- gcc 13.3.0, make, python3, Node v26.13.1 via nvm (0.40.7).
- SDL: runtime `libsdl2-2.0-0 2.30.0` and `libsdl2-mixer-2.0-0 2.8.0`
  were present from the start. The dev packages
  (`libsdl2-dev 2.30.0`, `libsdl2-mixer-dev 2.8.0`) were NOT present
  at the start of this lane's work.
- **Note on the install attempt**: `apt-get install -y libsdl2-dev
  libsdl2-mixer-dev` was declined at the user-confirmation step. This
  lane did NOT retry it and did NOT work around it. Later the same day
  the packages were found installed (by another lane, the parent, or
  the user — not by this lane), and the builds below then proceeded.

## 1. Shareware build — PASS

```
cd repo && make -C src clean && make -C src SHAREWARE=1
# exit 0; binary src/rott, 2,668,832 bytes, ELF 64-bit x86-64
# Only warnings observed (-Wshadow etc.); no errors.
# (An early grep for "error" in the output matched only the function
#  name UL_DisplayMemoryError / SoftError call sites, not real errors.)
```

## 2. Default (commercial/registered) build — PASS (compiles)

```
cd repo && make -C src clean && make -C src
# grep -c "error:" -> 0
# binary src/rott, 2,924,056 bytes
```

No registered game data was available or used. The registered binary
was run once with shareware data as a negative control (see §4).

## 3. Shareware run to the menu — PASS (with Xvfb)

Shareware data (local testing only, from `1rott13.zip`, see
INTERFACES.md) was placed next to the binary; `$HOME` pointed at an
empty dir so the game's own config writes were observable.

```
mkdir -p /tmp/rott-run && cp repo/src/rott /tmp/rott-run/
cp data-shareware/HUNTBGIN.* data-shareware/DEMO*.DMO \
   data-shareware/REMOTE1.RTS /tmp/rott-run/
cd /tmp/rott-run
HOME=/tmp/rott-run SDL_AUDIODRIVER=dummy timeout 15 \
  xvfb-run -a -s "-screen 0 1024x768x24" ./rott
# RUN_EXIT=124 — still running at the 15 s timeout: reached the
# interactive loop, no crash, no missing-data error.
```

Startup log (abridged):

```
Rise of the Triad Startup  Version 1.4
 Shareware Version
Z_INIT: 899950000 bytes
IN_Startup: Mouse Present
    Adding HUNTBGIN.WAD.
    Adding REMOTE1.RTS.
W_Wad: Wad Manager Started NUMLUMPS=2103
RT_DRAW: Tables Initialized
MU_Startup:
SD_SetupFXCard: Fx ok.
SD_Startup: Fx ok.
RT_MAIN: Fonts Initialized
RT_MSG: Message System Started
RT_VIEW: Colormaps Initialized
```

A second run under a manually started Xvfb (`:99`, 1024x768x24) was
screenshotted after 9 s with `xwd`. A screenshot was captured during
verification and lives in the lane workspace
(`~/workspace/rott-fleet/lane-1-wasm/outputs/native-menu-screenshot.png`);
it is evidence only and is NOT committed to the repo. It shows
the game rendering the red **APOGEE** logo splash full-screen — the
intro sequence is playing, i.e. the game is past startup and
rendering frames. Config files written by the game to
`$HOME/.rott/`: `config.rot`, `sound.rot`, `battle.rot`,
`scores.rot` (a `VENDOR.DOC` also appeared there; which component
placed it there was not investigated).

### Dummy video driver — expected failure, not a game bug

```
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy timeout 12 ./rott
# RUN_EXIT=1, "CreateTextureFromSurface failed: Parameter 'renderer'
# is invalid" — the dummy driver provides no renderer, so the engine
# cannot create textures. This is a limitation of headless testing,
# not of the build. Xvfb is the way to run it headless.
```

## 4. Negative control: registered binary + shareware data — behaves correctly

```
# default build (SHAREWARE=0) run with only HUNTBGIN.* present:
Error, Could not find User file 'DARKWAR.WAD', ignoring file
    Adding REMOTE1.RTS.
W_Wad: Wad Manager Started NUMLUMPS=12
W_GetNumForName: tables not found! Episode = 0 / Area = 1
# ...then created $HOME/.rott/darkwar/ and continued without data.
```

This confirms the two builds really are different binaries with
different data expectations. No DARKWAR.* data exists in this lane.

## Phase 1 verdict

**Done**: `src/rott` builds clean in both configurations and the
shareware build reaches the interactive loop and renders (Apogee
splash seen on screen). "Reaches the menu" is verified to the extent
a headless run allows: the game is in its intro/menu flow and
rendering; no human pressed a key to step from splash to menu, and
no interactive play session was driven natively (no display/keyboard
in this environment).

## Phase 3 (WASM) build status

- Emscripten 7.0.0 via emsdk (`install latest`), verified with
  `emcc --version`. See `emsdk-setup.md` (includes the tar
  `--no-same-owner` workaround for this VM).
- First `emcc` attempt failed: `src/dosutil.c:236: 'execinfo.h' file
  not found`. Fixed without touching `src/` via the MIT stub
  `compat/emscripten/execinfo.h` (backtrace stub; WASM crash stack
  dumps will be empty — browser devtools are the crash route) plus
  `-Icompat/emscripten` in `Makefile.emcc`.
- Rebuild with the shim: **PASS (link step)**. Command (run from the
  scratch clone, with the lane's outputs referenced by absolute path):

```
source emsdk/emsdk_env.sh
make -f outputs/Makefile.emcc \
  PREJS=outputs/web/rott-pre.js \
  DATA_DIR=lane-1-wasm/data-shareware \
  COMPAT_DIR=outputs/compat/emscripten \
  OUTDIR=/tmp/rott-wasm-build
# exit 0; warnings only (unused parameters in audiolib, -Wshadow etc.)
```

  Outputs in `/tmp/rott-wasm-build/` (ephemeral; the deliverable is
  the Makefile, not these binaries):

| file | bytes | sha256 (first 16 hex) |
|---|---|---|
| `rott.wasm` | 2,195,699 | `c1b9e23c98c2e734…` |
| `rott.js` | 169,427 | `886a602e6a7dd835…` |
| `rott.data` | 6,850,433 | `66482494108d38c1…` |

  Verified on the outputs: `node --check rott.js` OK; `rott.wasm`
  starts with the `\0asm` magic; all 8 preloaded data files
  (HUNTBGIN.RTC/.RTL/.WAD, DEMO1_3–4.DMO, REMOTE1.RTS) are referenced
  in `rott.js`; the pre-js IDBFS code is baked in (`IDBFS`,
  `rott-idbfs-sync` run dependency present); `asyncify` present;
  SDL2 referenced throughout. `git status` in the scratch clone shows
  only the untracked native `src/rott` binary — no source file was
  modified.
- **Not checked (no browser in this environment)**: loading
  `rott.js` in Chrome, reaching the menu, keyboard/mouse play, audio,
  IDBFS save persistence. These need a live Chrome check or a CI
  headless-browser smoke test (follow-up, not in this lane). Phase 3's
  "Done means" is therefore **not yet fully verified** — the build
  half is done and verified; the Chrome half is outstanding.
