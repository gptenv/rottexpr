<!-- SPDX-License-Identifier: MIT -->
# BRIDGE-CONTRACT.md — DOM interface between the WASM game and lane 2's bridge

Status: draft for lane 2 (sidecar/bridge). Version 1, 2026-11-18.
License: MIT. This document describes a player-layer interface only.

## The boundary, in one paragraph

The bridge (lane 2) is a separate MIT program. It talks to the game only
through interfaces the game already has: synthetic DOM input events into
the canvas, canvas pixels out, and the game's own files (saves, config,
data). It never modifies the engine in `src/`, never compiles code into
the WASM module, never reads the WASM module's memory, and never calls
Emscripten runtime internals (no `Module`, no `FS`, no HEAP access from
the bridge — the pre-js file `web/rott-pre.js` is part of lane 1's build
config, not the bridge). If a feature needs engine internals, the bridge
does without it or finds a public interface for it.

## 1. Page elements (web/index.html)

| Element | Selector | Notes |
|---|---|---|
| Game canvas | `#rott-canvas` | `<canvas width="640" height="400" tabindex="0">`. Emscripten SDL renders here. Focus it before sending keys. |
| Start button | `#start-btn` inside `#start-overlay` | Must be clicked by a human (or a real user gesture) to unlock WebAudio. The bridge must NOT auto-click it in a way that defeats autoplay policy — audio simply will not start without a gesture. After the click the overlay hides and `rott.js` loads. |
| Status line | `#rott-status` | Human-readable status text; engine stdout/stderr is forwarded here (last 5 lines) via `window.__rottLog`. |

The module script `rott.js` is loaded dynamically by `web/app.js` after
the Start click. The bridge must wait for the game to exist before
driving it: poll `window.ROTT && document.querySelector('#rott-canvas')`
and treat "canvas has non-black pixels" as the liveness signal.

## 2. `window.ROTT` — the bridge's only API (web/app.js)

All functions are synchronous, return a value, and never throw (they
return `false`/`null` on failure).

```js
window.ROTT = {
  canvas: HTMLCanvasElement,          // #rott-canvas

  getStatus() -> string,              // text of #rott-status

  // Screenshot. LIMITATION (honest): Emscripten creates the WebGL context
  // with preserveDrawingBuffer=false, so toDataURL() returns a blank frame
  // unless called in the same frame the game just rendered. Call it from
  // inside a requestAnimationFrame callback, or use
  // canvas.captureStream() + a video element. Do NOT call it from a timer.
  screenshot() -> string | null,      // data:image/png;base64,... or null

  // Synthetic keyboard input, exactly as a human keypress arrives.
  // type: "keydown" | "keyup" | "keypress"
  // code: physical key, e.g. "ArrowUp", "ControlLeft", "Space", "KeyA"
  // key:  key value, e.g. "ArrowUp", " ", "a" (defaults to code)
  dispatchKey(type, code, key) -> boolean,  // false if no canvas

  // Synthetic mouse input.
  // type: "mousedown" | "mouseup" | "mousemove" | "click" | ...
  // opts: { button, buttons, clientX, clientY, movementX, movementY }
  // clientX/Y default to canvas centre. movementX/Y are defined on the
  // event when supplied (pointer-lock deltas).
  dispatchMouse(type, opts) -> boolean,

  focusCanvas() -> boolean,           // focuses the canvas, returns !!canvas
};
```

### Input notes

- **Keyboard**: Emscripten SDL listens on the canvas/window for real
  `keydown`/`keyup` events. Synthetic events dispatched to the canvas
  bubble to the same listeners. Always send `keydown` + `keyup` pairs;
  holding a key = `keydown` once, `keyup` later (do not spam repeats —
  the game reads SDL key state, not repeat counts).
- **Mouse**: ROTT turns with the mouse when pointer lock is active.
  Pointer lock is requested by Emscripten's SDL layer on canvas click
  (when the game uses relative mouse mode). The bridge cannot force
  pointer lock without a user gesture — a synthetic click does not count
  as one. Practical consequence: mouse-look driving from the bridge is
  **best-effort** and may need a human click first; keyboard turning
  (arrow keys) always works. `movementX`/`movementY` on synthetic
  `mousemove` events are honoured only while pointer lock is held.
- **Keys the game uses** (defaults; rebindable in-game via the menu):
  arrows move/turn, `Ctrl` fire, `Space` use/open, `Shift` run,
  `1`–`9` weapons, `Esc` menu, `F1` help. Menu navigation is arrows +
  `Enter`.
- **No text injection**: there is no console or chat input in the game;
  do not try to type into it.

## 3. Files the bridge may read/write (player layer)

All paths are inside the Emscripten virtual filesystem. The bridge
accesses them ONLY through the page's own file APIs as exposed by lane 1
— i.e. it does not reach into `Module.FS` itself. How the bridge gets
file bytes is lane 2's design decision; the contract guarantees the
files exist at these paths and in these formats:

| Path (in the game) | What it is |
|---|---|
| `/home/web_user/.rott/config.rot` | Engine config (video, audio, controls, difficulty). Written by the game on exit/settings change. Format: engine-native binary/text — parse defensively; never assume layout across engine versions. |
| `/home/web_user/.rott/sound.rot` | Sound settings. |
| `/home/web_user/.rott/battle.rot` | Comm-bat (multiplayer) settings. |
| `/home/web_user/.rott/scores.rot` | High scores. |
| `/home/web_user/.rott/SAVEGAM?.ROT` (14 slots) | Save games. Created by the in-game save menu. These are the state-preservation mechanism for hot-swap (Phase 4): save, swap module, load. |
| `/HUNTBGIN.WAD`, `/HUNTBGIN.RTC`, `/HUNTBGIN.RTL` | Shareware data, preloaded read-only at `/` (MEMFS). |
| `/DEMO1_3.DMO` … `/DEMO4_3.DMO` | Attract-mode demo recordings, preloaded at `/`. |
| `/REMOTE1.RTS` | RemoteRidicule taunt data, preloaded at `/`. |

Persistence: saves/config live in **IDBFS** mounted at
`/home/web_user/.rott/` (see `web/rott-pre.js`). The mount is populated
from IndexedDB before `main()` runs and synced back every 30 s and on
`pagehide`. Consequences for the bridge:

- A save written by the game may take up to ~30 s to reach IndexedDB
  (or until the page hides). If the bridge needs a save *now*, it must
  trigger a sync — the mechanism for that is lane 2's to define (e.g. a
  page-side helper in the bridge that calls the same `FS.syncfs(false)`
  path the pre-js file uses — that helper lives in the page, not in the
  engine).
- On a fresh browser profile the save dir is empty; the game creates
  `config.rot` etc. on first run. Do not pre-seed files the game owns.
- Registered builds use `/home/web_user/.rott/darkwar/` instead of
  `/home/web_user/.rott/`. The bridge must detect which dir is in use
  (shareware build = `.rott/` directly; registered = `.rott/darkwar/`).

## 4. What the bridge can observe (and what it cannot)

- **Can**: the rendered frame (screenshot), the status line, the game's
  own files listed above, and whatever the in-game menus show (read the
  pixels — OCR or template matching is lane 2's problem).
- **Cannot**: exact live internal state (health, ammo counts, enemy
  positions, map layout) except as shown on screen/HUD or stored in save
  files. There is no memory read, no engine hook, no debug API. This is
  the honest price of a bridge that is not GPL, and it is also the
  honest model: agents play the way a human plays.
- **Timing**: the game runs at the engine's own frame rate under
  ASYNCIFY; input events are consumed on the game's next frame. Do not
  assume a fixed tick rate — poll screenshots, do not dead-reckon.

## 5. Lifecycle the bridge must handle

1. Page loads → canvas exists, game NOT loaded, overlay visible.
2. Human clicks Start → `rott.js` loads → IDBFS sync → `main()` runs →
   Apogee splash → title/menu. (First load downloads `rott.data`, ~6.5 MB.)
3. Game runs. The bridge drives it via `window.ROTT`.
4. Page hidden/closed → final IDBFS sync on `pagehide`.
5. Reload → saves/config restored from IndexedDB before `main()`.

## 6. What is NOT in this contract (deliberate gaps)

- No REST endpoints (lane 2 / Phase 4 defines them against this DOM API).
- No WebSocket channels (Phase 5).
- No multiplayer protocol use yet: `REMOTE1.RTS` is shipped, but
  driving Comm-bat over the engine's network protocol is Phase 8 work;
  the bridge does not speak it today.
- No direct file upload into the game: adding a WAD overlay means
  rebuilding `rott.data` (or a lane-2-defined MEMFS write path) — not
  part of this contract.
- No audio capture API: SDL_mixer → WebAudio is audible to the human;
  the bridge gets no audio stream.

## 7. Change policy

This file is owned by lane 1. Lane 2 may propose changes (new
`window.ROTT` methods, new observable files) but lane 1 implements them
— the bridge never reaches past this contract.
