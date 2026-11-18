<!-- SPDX-License-Identifier: MIT -->
# ROTT page bridge (`bridge/`)

The bridge is a separate MIT program and the **only** thing that touches the
running game. It sees what a human player sees (the screen and HUD) and does
what a human player does (keyboard and mouse). It talks to the game only
through interfaces the game already has: synthetic DOM input events into the
canvas, canvas screenshots, the game's own save/config/data files, and its
existing network protocol. It never modifies the engine in `src/`, never
compiles code into the WASM module, never reads WASM memory, and never calls
Emscripten runtime internals.

Version 1.1.0 — reconciled to `docs/BRIDGE-CONTRACT.md` (lane L15). The
reconciliation corrected the bridge's best-effort defaults against the
contract and, where the contract itself disagreed with the engine, against
the engine sources (read-only). Every correction below names its evidence.

## DOM interface

- **Canvas:** `#rott-canvas` (`<canvas width="640" height="400"
  tabindex="0">`). Focus it before sending keys. The bridge waits for the
  game with `RottBridge.waitForGame(timeoutMs)`, which polls for
  `window.ROTT` + `#rott-canvas` and treats "canvas has non-black pixels"
  as the liveness signal (contract §1).
- **Start button:** `#start-btn` inside `#start-overlay` must be clicked by
  a human (or a real user gesture) to unlock WebAudio. The bridge never
  auto-clicks it.
- **Status line:** `#rott-status`; engine stdout/stderr is forwarded there
  via `window.__rottLog`. When the page shell provides `window.ROTT`
  (contract §2), the bridge prefers its `getStatus()` / `screenshot()`;
  otherwise it falls back to its own rAF `drawImage` capture and the
  optional `window.RottStatus` shell object.
- **Input:** synthetic `keydown`/`keyup` pairs to the canvas (and `window`,
  because Emscripten SDL listens on both); `mousemove`/`mousedown`/
  `mouseup`/`click` with optional `movementX`/`movementY` pointer-lock
  deltas. Mouse-look is best-effort: a synthetic click cannot obtain
  pointer lock (that needs a user gesture), so `movementX`/`movementY` are
  honoured only while pointer lock is already held; keyboard turning
  (arrow keys) always works. Screenshots are taken inside
  `requestAnimationFrame` — a direct `toDataURL()` can return a blank frame
  because Emscripten creates the WebGL context with
  `preserveDrawingBuffer=false`.

## Files (player layer only)

| Path (in the game) | What it is |
|---|---|
| `/home/web_user/.rott/rottgam<hex>.rot` | Save games, 14 slots 0–13. Slot digit is hex (`itoa(slot, 16)`): slots 10–13 are `rottgama.rot` … `rottgamd.rot`. `rottgamf.rot` is the quicksave backup, not a menu slot. |
| `/home/web_user/.rott/config.rot` | Engine config — **read-only for the bridge**. Engine-native binary; never written. |
| `/home/web_user/.rott/sound.rot`, `battle.rot`, `scores.rot` | Sound / Comm-bat / high-score files — read-only for the bridge. |
| `/home/web_user/.rott/rott-bridge.json` | The bridge's own JSON config (written by `config.apply`). |
| `/HUNTBGIN.WAD`, `/HUNTBGIN.RTC`, `/HUNTBGIN.RTL`, `/DEMO1_3.DMO` … `/DEMO4_3.DMO`, `/REMOTE1.RTS` | Shareware data, preloaded read-only at `/`. |

Registered builds use `/home/web_user/.rott/darkwar/` instead of
`/home/web_user/.rott/`; the bridge detects which dir is in use when the FS
is exposed (override with `configure({saveDir})`).

Saves/config live in IDBFS mounted at the save dir, synced back every 30 s
and on `pagehide`. A save may take up to ~30 s to reach IndexedDB, so after
a save the bridge triggers a sync itself (`save.sync` /
`RottBridge.sync()` → `FS.syncfs(false)`).

## Keys and menus (engine-verified)

- Gameplay: arrows move/turn, `Ctrl` fire, `Space` use/open, `Shift` run,
  `1`–`9` weapons, `Esc` menu, `F1` help. Menu navigation is arrows +
  `Enter`, or the menu hotkeys below.
- `F6` quicksave: opens the save menu when no quicksave slot exists yet,
  otherwise quick-saves to the existing slot. **There is no quickload key.**
- `F2`–`F10` are RemoteRidicule taunts in-game — they do **not** save/load.
- Pause is the `Pause`/Break key, not `P`.
- Main-menu hotkeys: `n` new game, `c` Comm-bat, `r` restore game,
  `s` save game, `o` options, `v` view scores, `b` back to demo, `q` quit.
  Save/load slots are hotkeys `a`…`n` (slots 0–13). Saving to an occupied
  slot asks "Overwrite?" with Yes as the default — `Enter` confirms — then
  a name prompt (the old name is pre-filled; the bridge clears it before
  typing the new label).
- Save/load require an in-game session: SAVE GAME is inactive on the title
  menu.

## Sidecar link

The bridge opens a WebSocket to the sidecar at
`ws://<sidecar-host>:8787/bridge` (default `ws://localhost:8787/bridge`,
reconnect every 3 s) and answers JSON requests `{id, method, params}` with
`{id, ok, result|error}`. Methods: `input.key`, `input.mouse`,
`input.text`, `input.sequence`, `state.observe`, `screen.capture`,
`config.apply`, `config.read`, `save.quick`, `save.load`, `save.list`,
`save.sync`, `demo.play`, `demo.stop`, `mod.apply`, `mod.remove`,
`script.register`, `script.unregister`, `script.reload`, `wasm.swap`,
`game.new`, `game.pause`, `game.resume`, `game.quit`, `game.info`,
`game.wait`, `multiplayer.host`, `multiplayer.join`, `multiplayer.leave`,
`chat.type`. On connect it sends `bridge.hello` and, after a WASM swap
(`?load=<slot>`), re-loads the save.

## `RottBridge.configure()` overrides

Anything still uncertain can be overridden without editing the bridge:

```js
RottBridge.configure({
  canvas: "#rott-canvas",          // canvas selector
  sidecarUrl: "ws://localhost:8787/bridge",
  saveDir: "/home/web_user/.rott", // shareware dir; darkwar auto-detected
  configFile: "/home/web_user/.rott/rott-bridge.json",
  useModuleFS: true,               // false = menus/screen only, no FS use
  keys: { quicksave: "F6", pause: "Pause", menu: "Escape", confirm: "Enter", chat: "t" },
  menuSequences: { newGame: ["Escape", "n"], quitToMenu: ["Escape"],
                   hostGame: ["Escape", "c"], joinGame: ["Escape", "c"],
                   leaveGame: ["Escape"] },
});
```

## What the bridge cannot do (honest limits)

- **No exact live internal state.** Health, ammo, enemy positions, and map
  layout are visible only as shown on screen/HUD or stored in save files.
  Agents play the way a human plays.
- **No chat input in the game.** The engine has no free-text chat; its
  multiplayer messages are the `F2`–`F10` taunts. `chat.type` (open with
  `t`, type, `Enter`) is a placeholder kept for the sidecar API — override
  `keys.chat` if the page shell provides a real chat input.
- **No audio capture.** SDL_mixer → WebAudio is audible to the human; the
  bridge gets no audio stream.
- **WASM swap URL params.** `swapWasm()` reloads the page with
  `?wasm=<url>&load=<slot>`, but lane 1's `web/app.js` as written loads a
  fixed `rott.js` path and does **not** read those params — the swap works
  only once the page shell honours them.
- **Menu sequences past the first level are best-effort.** The main-menu
  and slot hotkeys above are engine-verified; the Comm-bat submenu paths
  behind `hostGame` / `joinGame` are not, and the bridge cannot see menu
  state except through pixels.

## Reconciliation log (L15 — what changed and why)

Corrected against `docs/BRIDGE-CONTRACT.md` and the engine sources:

| Default (before) | Reconciled (now) | Evidence |
|---|---|---|
| `canvas: "#canvas"` | `"#rott-canvas"` | Contract §1; `web/index.html:64`, `web/app.js:14`, `web/rott-pre.js` |
| Save files `SAVEGAM(\d).` / `save(\d).`, 10 slots 0–9 | `rottgam<hex>.rot`, 14 slots 0–13; `rottgamf.rot` excluded (quicksave backup) | `src/rt_menu.c:1217` (`SaveName="rottgam?.rot"`), `src/_rt_menu.h:161` (`NUMSAVEGAMES 14`), `src/rt_game.c:5472` (hex slot digit), `src/_rt_menu.h:173` (`QUICKSAVEBACKUP "rottgamf.rot"`). The contract's `SAVEGAM?.ROT` does not exist in the engine — the contract is wrong here, and this bridge follows the engine. |
| `configFile: ".../CONFIG.ROT"`, JSON written into it | Bridge JSON goes to `.../rott-bridge.json`; engine `config.rot` never written | `src/rt_cfg.c:134` (`config.rot`, lowercase, engine-native binary). The old path was a different file on a case-sensitive FS and would corrupt the engine config if it ever landed there. |
| `keys.save: "F2"`, `keys.load: "F3"`; save/load sent F-key, digit, Enter | `keys.quicksave: "F6"`; `saveGame`/`loadGame` drive the real menus: `Esc` → `s`/`r` → slot hotkey `a`+slot → `Enter` (overwrite) → name prompt | `src/rt_main.c:2097–2135` (F2–F10 are RemoteRidicule taunts), `:2326` (F6 quicksave), `src/rt_menu.c:378–379` (main-menu hotkeys `R`/`S`), `:392` (slot hotkeys `a`–`n`), `CP_SaveGame`/`CP_LoadGame` (overwrite prompt, name input, direct `DoLoad`) |
| `keys.pause: "P"` | `"Pause"` (keyCode 19) | `src/rt_in.c:312` (`SDLK_PAUSE` → `PausePressed`) |
| `saveDir` fixed shareware path | `resolveSaveDir()` detects `.rott/darkwar` for registered builds | Contract §3; `src/dosutil.c: setup_homedir`; `web/rott-pre.js:22–23` |
| No IDBFS sync trigger | `syncFiles()` / `save.sync`, called after every save | Contract §3 (bridge must trigger a sync when it needs a save now); `web/rott-pre.js` (`FS.syncfs`) |
| Screenshot always via `drawImage` | Prefers `window.ROTT.screenshot()` when the shell provides it, falls back to `drawImage` | Contract §2 (`window.ROTT` API) |
| No game-ready wait | `waitForGame()` / `game.wait` — polls `window.ROTT` + canvas, non-black pixels = live | Contract §1 (liveness signal) |
| `observe()` used `window.RottStatus` only | Prefers `window.ROTT.getStatus()` | Contract §2 |
| Mouse events had no `movementX`/`movementY` | Passed through when supplied | Contract §2 |
| Menu sequences `newGame: [Esc, Enter]`, `quitToMenu: [Esc, Down×3, Enter]`, `host/join/leave: [Esc]` | `newGame: [Esc, n]`, `quitToMenu: [Esc]`, `host/join: [Esc, c]`, `leave: [Esc]` | Main-menu hotkeys (`rt_menu.c`); deeper Comm-bat paths still unconfirmed (see limits) |

Confirmed unchanged (already matched the contract): sidecar URL
`ws://localhost:8787/bridge`, 3 s reconnect, `dataDir: "/"`, rAF
screenshot capture, `window.RottStatus` merge in `observe()`,
`?wasm=`/`?load=` swap mechanism (see the limit above — the page shell
must honour them).

Known contract tension, recorded not resolved: the contract's boundary
paragraph says the bridge must not access `Module`/`FS`, while §3
explicitly contemplates "a page-side helper in the bridge that calls the
same `FS.syncfs(false)` path the pre-js file uses". This bridge treats the
page-exposed `window.Module.FS` as the page's own file API (the same one
the engine uses for saves/config/data), never touches HEAP or WASM memory,
and can run without it — `configure({useModuleFS: false})` disables all FS
use (menus/screen only; save listing, bridge config, and WAD overlays
report as unavailable). If lane 1 ever exposes file access through
`window.ROTT` instead, the FS path should move there.

## Verification

- `node --check bridge/rott-bridge.js` — passes.
- Runtime smoke test (Node, DOM stubs, fake `Module.FS` + fake WebSocket;
  not landed): 27/27 checks pass — `save.list` finds slots 0/9/10/13 from
  `rottgam*.rot` and ignores `SAVEGAM1.ROT` and `rottgamf.rot`;
  `config.apply` writes `rott-bridge.json` and never `config.rot`;
  `save.sync` succeeds; `saveGame` sends `Escape, s, <slot hotkey>,
  Enter, <clear name>, <label>, Enter`; `loadGame` sends `Escape, r,
  <slot hotkey>`; `game.wait` resolves ready+live with `window.ROTT`
  present and times out cleanly without it; mouse `movementX` passes
  through. The real game was not driven: no live browser run was done in
  this lane (menu sequences are verified against the engine source, not
  against a running game).
