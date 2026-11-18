<!-- SPDX-License-Identifier: MIT -->
# ROTT Sidecar REST API — curl examples

Copy-pasteable `curl` examples for **all 36 operations** in the ROTT sidecar
REST API. The source of truth is [`openapi.yaml`](openapi.yaml): every
method + path below exists in that spec, with the same `operationId`, request
body, and response shape. If this file and the spec ever disagree, the spec
wins — please fix this file, not the spec.

The sidecar is MIT-licensed sidecar code. It drives the game only through
player-layer interfaces (synthetic DOM input, screenshots, the game's own
save/config/data files, its existing network protocol). Nothing here touches
the engine in `src/`. See `docs/websocket.md` for the WebSocket transport,
which dispatches to the same handlers.

## Conventions

```sh
# The sidecar listens on PORT (default 8787). Point BASE at your server:
BASE="${ROTT_BASE_URL:-http://localhost:8787}"
```

- There is **no authentication**. The sidecar is a local development server;
  do not expose it to a network you do not trust.
- All JSON requests send `-H 'Content-Type: application/json'` with a `-d`
  body. All JSON responses are `application/json`, except `GET /api/v1/screen`,
  which returns `image/png`.
- `curl -sS` is used throughout so errors are shown instead of swallowed.
  `-w '\nHTTP %{http_code}\n'` prints the status code after the body.
- Errors look like `{"code": "BRIDGE_OFFLINE", "message": "..."}`. The codes
  you will see most: `BAD_REQUEST` (400, bad body/path), `NOT_FOUND` (404,
  unknown mod/script id or empty save slot), `BRIDGE_OFFLINE` (503, no game
  page connected — see below), `CONFLICT` (409).

### What works with no game page connected

Some operations are pure sidecar state and work with no bridge (no game page
running). These always return `200` (assuming valid input):

`getHealth`, `getState`, `getConfig`, `putConfig`, `getConfigSection`,
`listSaves`, `listMods`, `loadMod`, `getMod`, `unloadMod`, `listScripts`,
`getScript`, `unregisterScript`, `getGameInfo`, `listChat`, `sendChat`.

Everything else needs a connected bridge and returns `503 BRIDGE_OFFLINE`
when there is none: `getScreen`, all four `input/*` operations, `saveGame`,
`loadGame`, `playDemo`, `stopDemo`, `reloadMod`, `registerScript`,
`reloadScript`, `swapWasm`, `newGame`, `pauseGame`, `resumeGame`,
`quitGame`, `hostMultiplayer`, `joinMultiplayer`, `leaveMultiplayer`.

`putConfig` is the middle case: it always returns `200` and persists the
config server-side, but with no bridge the response includes
`"pendingReload": ["bridge-offline"]` — the bridge applies it when it
(re)connects. `loadMod` is similar: it returns `200` with
`"status": "loaded"` and an `error` note saying the overlays apply on the
next bridge connect.

### Operation index (36 ops, 30 paths)

| # | Method | Path | operationId | Group |
|---|--------|------|-------------|-------|
| 1 | GET | `/health` | `getHealth` | Health |
| 2 | GET | `/api/v1/state` | `getState` | State |
| 3 | GET | `/api/v1/screen` | `getScreen` | State |
| 4 | POST | `/api/v1/input/key` | `sendKey` | Input |
| 5 | POST | `/api/v1/input/mouse` | `sendMouse` | Input |
| 6 | POST | `/api/v1/input/text` | `sendText` | Input |
| 7 | POST | `/api/v1/input/sequence` | `sendInputSequence` | Input |
| 8 | GET | `/api/v1/config` | `getConfig` | Config |
| 9 | PUT | `/api/v1/config` | `putConfig` | Config |
| 10 | GET | `/api/v1/config/{section}` | `getConfigSection` | Config |
| 11 | GET | `/api/v1/saves` | `listSaves` | Saves |
| 12 | POST | `/api/v1/save` | `saveGame` | Saves |
| 13 | POST | `/api/v1/load` | `loadGame` | Saves |
| 14 | POST | `/api/v1/demo/play` | `playDemo` | Demo |
| 15 | POST | `/api/v1/demo/stop` | `stopDemo` | Demo |
| 16 | GET | `/api/v1/mods` | `listMods` | Mods |
| 17 | POST | `/api/v1/mods` | `loadMod` | Mods |
| 18 | GET | `/api/v1/mods/{id}` | `getMod` | Mods |
| 19 | DELETE | `/api/v1/mods/{id}` | `unloadMod` | Mods |
| 20 | POST | `/api/v1/mods/{id}/reload` | `reloadMod` | Mods |
| 21 | GET | `/api/v1/scripts` | `listScripts` | Scripts |
| 22 | POST | `/api/v1/scripts` | `registerScript` | Scripts |
| 23 | GET | `/api/v1/scripts/{name}` | `getScript` | Scripts |
| 24 | DELETE | `/api/v1/scripts/{name}` | `unregisterScript` | Scripts |
| 25 | POST | `/api/v1/scripts/{name}/reload` | `reloadScript` | Scripts |
| 26 | POST | `/api/v1/wasm/swap` | `swapWasm` | WASM swap |
| 27 | GET | `/api/v1/game/info` | `getGameInfo` | Lifecycle |
| 28 | POST | `/api/v1/game/new` | `newGame` | Lifecycle |
| 29 | POST | `/api/v1/game/pause` | `pauseGame` | Lifecycle |
| 30 | POST | `/api/v1/game/resume` | `resumeGame` | Lifecycle |
| 31 | POST | `/api/v1/game/quit` | `quitGame` | Lifecycle |
| 32 | POST | `/api/v1/multiplayer/host` | `hostMultiplayer` | Multiplayer |
| 33 | POST | `/api/v1/multiplayer/join` | `joinMultiplayer` | Multiplayer |
| 34 | POST | `/api/v1/multiplayer/leave` | `leaveMultiplayer` | Multiplayer |
| 35 | GET | `/api/v1/chat` | `listChat` | Chat |
| 36 | POST | `/api/v1/chat` | `sendChat` | Chat |

A runnable version of this whole page is `server/examples/rest-smoke.sh`,
which issues one request per operation against a live sidecar and checks the
status code of each (accepting `503` where the spec says the bridge is
required and none is connected).

## Health

### 1. `GET /health` — `getHealth`

Server health and bridge connectivity. Works with no bridge.

```sh
curl -sS "$BASE/health"
```

Expect `200`:

```json
{"status": "ok", "bridgeConnected": false, "uptimeSeconds": 42, "version": "1.0.0"}
```

`status` is `degraded` instead of `ok` when the bridge is down; `200` either
way — this endpoint never 503s.

## State

### 2. `GET /api/v1/state` — `getState`

The full observable game state: status, episode/level, HUD values, save
slots, latest screen hash. Fields the bridge cannot observe are `null`.
Does not force a fresh capture. Works with no bridge (returns
`"status": "offline"`).

```sh
curl -sS "$BASE/api/v1/state"
```

Expect `200`:

```json
{
  "status": "menu",
  "bridgeConnected": true,
  "episode": 1,
  "level": 1,
  "levelName": null,
  "difficulty": "normal",
  "health": 100,
  "armor": 0,
  "ammo": {"Pistol": 100},
  "weapons": ["Pistol"],
  "score": 0,
  "lives": 3,
  "screenHash": "a1b2c3d4",
  "screenCapturedAt": "2026-11-18T22:00:00.000Z",
  "hudText": null,
  "saveSlots": [],
  "updatedAt": "2026-11-18T22:00:00.000Z"
}
```

### 3. `GET /api/v1/screen` — `getScreen`

The latest game frame as a PNG screenshot. Needs a bridge: `503
BRIDGE_OFFLINE` with no game page connected.

```sh
curl -sS "$BASE/api/v1/screen" -o screen.png -w 'HTTP %{http_code}\n'
file screen.png   # PNG image data, 640 x 400 (or the configured resolution)
```

Expect `200` with a PNG body, or `503` with a JSON error when no bridge is
connected.

## Input

All four input operations dispatch synthetic DOM events to the game canvas,
exactly as a human key press / mouse action. They need a bridge (`503`
without one). Invalid bodies return `400 BAD_REQUEST`.

### 4. `POST /api/v1/input/key` — `sendKey`

`key` is a DOM `KeyboardEvent.key` (`"ArrowUp"`, `"w"`, `"Escape"`, `"F2"`,
`" "` for space). `code` is optional and derived from `key` when omitted.
`action` is `down`, `up`, or `press` (default `press` = keydown, wait
`holdMs`, keyup; `holdMs` defaults to 50, max 5000).

```sh
# Walk forward for 200 ms, then stop is the caller's job (key up):
curl -sS -X POST "$BASE/api/v1/input/key" \
  -H 'Content-Type: application/json' \
  -d '{"key": "w", "code": "KeyW", "action": "down"}'

# A single press (keydown + keyup after holdMs):
curl -sS -X POST "$BASE/api/v1/input/key" \
  -H 'Content-Type: application/json' \
  -d '{"key": "ArrowUp", "action": "press", "holdMs": 200}'

# Release the key again:
curl -sS -X POST "$BASE/api/v1/input/key" \
  -H 'Content-Type: application/json' \
  -d '{"key": "w", "code": "KeyW", "action": "up"}'

# Open the pause menu with Escape:
curl -sS -X POST "$BASE/api/v1/input/key" \
  -H 'Content-Type: application/json' \
  -d '{"key": "Escape", "action": "press"}'
```

Expect `200`: `{"accepted": true, "echoed": {"key": "ArrowUp", "action": "press", "holdMs": 200}}`.

### 5. `POST /api/v1/input/mouse` — `sendMouse`

`x`/`y` are CSS pixels from the canvas top-left corner. `button` defaults
to `left`. `action` is `down`, `up`, `click` (mousedown + mouseup), or
`move` (mousemove only).

```sh
# Click the centre of a 640x400 canvas (e.g. a menu button):
curl -sS -X POST "$BASE/api/v1/input/mouse" \
  -H 'Content-Type: application/json' \
  -d '{"x": 320, "y": 200, "button": "left", "action": "click"}'

# Just move the mouse (aim / menu hover) without clicking:
curl -sS -X POST "$BASE/api/v1/input/mouse" \
  -H 'Content-Type: application/json' \
  -d '{"x": 400, "y": 150, "action": "move"}'
```

Expect `200`: `{"accepted": true}`.

### 6. `POST /api/v1/input/text` — `sendText`

Types text as a sequence of key presses — for a player name, a save label,
or a line of in-game chat.

```sh
curl -sS -X POST "$BASE/api/v1/input/text" \
  -H 'Content-Type: application/json' \
  -d '{"text": "PLAYER1"}'
```

Expect `200`: `{"accepted": true}`.

### 7. `POST /api/v1/input/sequence` — `sendInputSequence`

An ordered macro of input events (1–500). Each step has exactly one of
`key`, `mouse`, or `text`, plus an optional `delayMs` wait after it. The
classic use is menu navigation: open the menu, move down twice, confirm.

```sh
curl -sS -X POST "$BASE/api/v1/input/sequence" \
  -H 'Content-Type: application/json' \
  -d '{
    "events": [
      {"key": {"key": "Escape", "action": "press"}, "delayMs": 300},
      {"key": {"key": "ArrowDown", "action": "press"}, "delayMs": 150},
      {"key": {"key": "ArrowDown", "action": "press"}, "delayMs": 150},
      {"key": {"key": "Enter", "action": "press"}, "delayMs": 500},
      {"mouse": {"x": 320, "y": 200, "action": "click"}}
    ]
  }'
```

Expect `200`: `{"accepted": true, "executed": 5}` — `executed` is the number
of input events run.

## Config

Config is applied through the game's own config file and/or its in-game
menus, driven by the bridge. Some video options only take effect when the
WASM module is (re)loaded; the `PUT` response reports those in
`pendingReload`. The game is never restarted by these endpoints.

### 8. `GET /api/v1/config` — `getConfig`

```sh
curl -sS "$BASE/api/v1/config"
```

Expect `200` with the whole `Config` object (`video`, `audio`, `controls`,
`difficulty`, `options`). Works with no bridge.

### 9. `PUT /api/v1/config` — `putConfig`

Partial: unlisted fields keep their current values. Always returns `200`
and persists server-side; with no bridge the response reports
`"pendingReload": ["bridge-offline"]`.

```sh
curl -sS -X PUT "$BASE/api/v1/config" \
  -H 'Content-Type: application/json' \
  -d '{
    "video": {"resolution": "640x400", "fullscreen": false, "brightness": 5},
    "audio": {"musicVolume": 70, "sfxVolume": 80, "musicEnabled": true, "sfxEnabled": true},
    "controls": {"forward": "w", "fire": "ControlLeft"},
    "difficulty": "normal",
    "options": {"crosshair": true, "autoRun": false, "mouseLook": true, "hudScale": "normal"}
  }'
```

Valid `resolution` values: `"320x200"`, `"640x400"`, `"800x600"`,
`"1024x768"`, `"fullscreen"`. Valid `difficulty` values: `easy`, `normal`,
`hard`, `very-hard`. Valid `hudScale` values: `small`, `normal`, `large`.

### 10. `GET /api/v1/config/{section}` — `getConfigSection`

One section at a time. `section` must be one of `video`, `audio`,
`controls`, `difficulty`, `options`; anything else is `400 BAD_REQUEST`.
Works with no bridge.

```sh
curl -sS "$BASE/api/v1/config/video"
curl -sS "$BASE/api/v1/config/audio"
curl -sS "$BASE/api/v1/config/controls"
curl -sS "$BASE/api/v1/config/difficulty"
curl -sS "$BASE/api/v1/config/options"
```

Expect `200`, e.g. for `video`:
`{"resolution": "640x400", "fullscreen": false, "brightness": 5, "gamma": 5}`.
For `difficulty` the body is a bare string: `"normal"`.

## Saves

Saves go through the game's own save/load mechanism, driven by the bridge.
Slots are integers 0–9.

### 11. `GET /api/v1/saves` — `listSaves`

```sh
curl -sS "$BASE/api/v1/saves"
```

Expect `200`, an array of save slots (`[]` when none exist, or when no
bridge is connected — the stored slots are returned either way):

```json
[{"slot": 1, "label": "Before the boss", "levelName": "E1L3", "savedAt": "2026-11-18T22:00:00.000Z", "exists": true}]
```

### 12. `POST /api/v1/save` — `saveGame`

Needs a bridge (`503` without one). `label` is optional.

```sh
curl -sS -X POST "$BASE/api/v1/save" \
  -H 'Content-Type: application/json' \
  -d '{"slot": 1, "label": "Before the boss"}'
```

Expect `200` with the saved slot:
`{"slot": 1, "label": "Before the boss", "exists": true, ...}`.

### 13. `POST /api/v1/load` — `loadGame`

Loads a save slot through the game's own load mechanism and returns the
fresh observable state. Needs a bridge (`503` without one); an empty slot
is `404 NOT_FOUND`.

```sh
curl -sS -X POST "$BASE/api/v1/load" \
  -H 'Content-Type: application/json' \
  -d '{"slot": 1}'
```

Expect `200` with an `ObservableState` body (same shape as `GET
/api/v1/state`).

## Demo

Demo playback uses the `DEMO1_3`–`DEMO4_3` files shipped with the shareware
game data, via the game's own demo playback. Both operations need a bridge.

### 14. `POST /api/v1/demo/play` — `playDemo`

```sh
curl -sS -X POST "$BASE/api/v1/demo/play" \
  -H 'Content-Type: application/json' \
  -d '{"demo": "DEMO1_3", "loop": false}'
```

`demo` must be one of `DEMO1_3`, `DEMO2_3`, `DEMO3_3`, `DEMO4_3` — anything
else is `400`. Expect `200` with the fresh `ObservableState`
(`"status": "demo"`).

### 15. `POST /api/v1/demo/stop` — `stopDemo`

No body.

```sh
curl -sS -X POST "$BASE/api/v1/demo/stop"
```

Expect `200` with the fresh `ObservableState`.

## Mods

Data-driven mods only: JSON value overrides plus optional WAD overlay files.
A mod never contains code and never touches the engine. Values the engine
only reads at load time take effect on the next level load. The bundled
example is `mods/example-mod` (`double-damage`).

### 16. `GET /api/v1/mods` — `listMods`

```sh
curl -sS "$BASE/api/v1/mods"
```

Expect `200`, an array of mods (loaded and available-but-unloaded). Works
with no bridge.

### 17. `POST /api/v1/mods` — `loadMod`

Registers the manifest and applies it. Returns `200` even with no bridge —
in that case the mod records `"status": "loaded"` with an `error` note that
the overlays apply on the next bridge connect.

```sh
curl -sS -X POST "$BASE/api/v1/mods" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "double-damage",
    "name": "Double Damage (example)",
    "version": "0.1.0",
    "description": "Example data-driven mod: the starting pistol hits harder, the lowest-tier guard is a little tougher, and level 1 gets more health pickups. JSON values only.",
    "enabled": true,
    "weapons": {"Pistol": {"damage": 40}},
    "enemies": {"Guard": {"health": 120}},
    "levels": {"E1L1": {"extraHealthPickups": 4}},
    "wadOverlays": []
  }'
```

`id` must match `^[a-z0-9][a-z0-9_-]*$`. Expect `200` with the `Mod` object
(`id`, `name`, `version`, `loadedAt`, `status`, `error`).

### 18. `GET /api/v1/mods/{id}` — `getMod`

```sh
curl -sS "$BASE/api/v1/mods/double-damage"
```

Expect `200` with the `Mod` object, or `404` for an unknown id. Works with
no bridge.

### 19. `DELETE /api/v1/mods/{id}` — `unloadMod`

Removes the mod's overlays and value overrides; values the engine already
read at load time revert on the next level load.

```sh
curl -sS -X DELETE "$BASE/api/v1/mods/double-damage"
```

Expect `200` with the unloaded `Mod` object, or `404` for an unknown id.
Works with no bridge.

### 20. `POST /api/v1/mods/{id}/reload` — `reloadMod`

Re-reads the mod's manifest and overlays and re-applies them. Needs a
bridge (`503` without one).

```sh
curl -sS -X POST "$BASE/api/v1/mods/double-damage/reload"
```

Expect `200` with the `Mod` object, or `404` for an unknown id.

## Scripts

The script layer is plain JS that runs in the page's JS context, **outside**
the WASM module. Scripts drive the game only through `window.RottBridge`
(synthetic input + screen/save observation). They cannot read WASM memory
or engine state. A script may define `onTick(state)`, `onEvent(event)`, and
`onLoad()` hooks; the bridge calls them. Reloading a script re-evaluates it
in place — the game is not restarted.

### 21. `GET /api/v1/scripts` — `listScripts`

```sh
curl -sS "$BASE/api/v1/scripts"
```

Expect `200`, an array of scripts. Works with no bridge.

### 22. `POST /api/v1/scripts` — `registerScript`

Registers (or replaces) a script-layer program. Needs a bridge (`503`
without one) — the bridge is what evaluates the code.

```sh
curl -sS -X POST "$BASE/api/v1/scripts" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "watch-health",
    "code": "function onTick(state) { if (state.health !== null && state.health < 30) { RottBridge.sendKey({key: \"Escape\", action: \"press\"}); } }",
    "enabled": true
  }'
```

`name` must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$` and `code` must be
non-empty, or the request is `400`. Expect `200` with the `Script` object.

### 23. `GET /api/v1/scripts/{name}` — `getScript`

```sh
curl -sS "$BASE/api/v1/scripts/watch-health"
```

Expect `200` with the `Script` object (including its source), or `404` for
an unknown name. Works with no bridge.

### 24. `DELETE /api/v1/scripts/{name}` — `unregisterScript`

```sh
curl -sS -X DELETE "$BASE/api/v1/scripts/watch-health"
```

Expect `200` with the removed `Script` object, or `404` for an unknown
name. Works with no bridge.

### 25. `POST /api/v1/scripts/{name}/reload` — `reloadScript`

Re-evaluates the script's current source in place. Needs a bridge (`503`
without one).

```sh
curl -sS -X POST "$BASE/api/v1/scripts/watch-health/reload"
```

Expect `200` with the `Script` object, or `404` for an unknown name.

## WASM swap

### 26. `POST /api/v1/wasm/swap` — `swapWasm`

Hot-swaps the WASM module with state preserved through the game's own save
files: the bridge saves the game to the requested slot, the page reloads
with the new module URL, and the bridge loads the save. The page reload
itself is unavoidable — that is the honest mechanism, and it is why the
save step exists. No recompile of the running game happens; the new module
must already be built (by CI or a local emsdk build). Needs a bridge
(`503` without one).

```sh
curl -sS -X POST "$BASE/api/v1/wasm/swap" \
  -H 'Content-Type: application/json' \
  -d '{"moduleUrl": "http://localhost:8080/rott.wasm", "saveSlot": 9}'
```

`moduleUrl` is required; `saveSlot` defaults to 9. Expect `200`:
`{"accepted": true, "saveSlot": 9, "moduleUrl": "http://localhost:8080/rott.wasm", "note": "..."}`.

Because the swap reloads the game page, the runnable smoke script
(`server/examples/rest-smoke.sh`) only exercises this operation with
`--include-wasm-swap`; by default it reports it as skipped.

## Lifecycle

Lifecycle operations are menu-driven by the bridge and return the fresh
observable state. All of them need a bridge (`503` without one).

### 27. `GET /api/v1/game/info` — `getGameInfo`

Static game/bridge info: data set, episodes, demos, versions. This one
works with no bridge.

```sh
curl -sS "$BASE/api/v1/game/info"
```

Expect `200`:

```json
{
  "title": "Rise of the Triad",
  "version": null,
  "dataSet": "shareware",
  "episodes": [
    {"episode": 1, "name": "The HUNT Begins", "levels": 11},
    {"episode": 2, "name": "Mystical Mission", "levels": 11},
    {"episode": 3, "name": "The Dark War", "levels": 11}
  ],
  "demosAvailable": ["DEMO1_3", "DEMO2_3", "DEMO3_3", "DEMO4_3"],
  "bridgeVersion": "1.0.0",
  "wasmModuleUrl": null
}
```

### 28. `POST /api/v1/game/new` — `newGame`

Starts a new game. All fields are optional (defaults: episode 1, level 1,
`normal` difficulty).

```sh
curl -sS -X POST "$BASE/api/v1/game/new" \
  -H 'Content-Type: application/json' \
  -d '{"episode": 1, "level": 1, "difficulty": "normal"}'
```

Expect `200` with the fresh `ObservableState` (`"status": "playing"`).

### 29. `POST /api/v1/game/pause` — `pauseGame`

No body.

```sh
curl -sS -X POST "$BASE/api/v1/game/pause"
```

Expect `200` with the fresh `ObservableState` (`"status": "paused"`).

### 30. `POST /api/v1/game/resume` — `resumeGame`

No body.

```sh
curl -sS -X POST "$BASE/api/v1/game/resume"
```

Expect `200` with the fresh `ObservableState` (`"status": "playing"`).

### 31. `POST /api/v1/game/quit` — `quitGame`

Quits to the main menu. No body.

```sh
curl -sS -X POST "$BASE/api/v1/game/quit"
```

Expect `200` with the fresh `ObservableState` (`"status": "menu"`).

## Multiplayer

Multiplayer goes through the game's **existing network protocol**, driven
via its own multiplayer menus by the bridge. The sidecar does not implement
the network protocol itself. All three operations need a bridge (`503`
without one).

### 32. `POST /api/v1/multiplayer/host` — `hostMultiplayer`

Hosts a game. `mode` is `comm-bat` (deathmatch) or `cooperative`;
`maxPlayers` is 2–11. All fields are optional (defaults: `comm-bat`, 4
players, episode 1, level 1).

```sh
curl -sS -X POST "$BASE/api/v1/multiplayer/host" \
  -H 'Content-Type: application/json' \
  -d '{"mode": "comm-bat", "maxPlayers": 4, "episode": 1, "level": 1}'
```

Expect `200` with the fresh `ObservableState`.

### 33. `POST /api/v1/multiplayer/join` — `joinMultiplayer`

Joins a hosted game. `address` is the host address as the engine's own
multiplayer menu expects it; `playerName` is optional.

```sh
curl -sS -X POST "$BASE/api/v1/multiplayer/join" \
  -H 'Content-Type: application/json' \
  -d '{"address": "192.168.1.10", "playerName": "agent-1"}'
```

Expect `200` with the fresh `ObservableState`. There is no way to list
available hosts through the API — the address must come from whoever is
hosting (see `hostMultiplayer` above, or the match runner).

### 34. `POST /api/v1/multiplayer/leave` — `leaveMultiplayer`

Leaves the current multiplayer game. No body.

```sh
curl -sS -X POST "$BASE/api/v1/multiplayer/leave"
```

Expect `200` with the fresh `ObservableState`.

## Chat

Agent chat / steering messages. These are pure sidecar state plus a
WebSocket broadcast (`game.chat` channel, see `docs/websocket.md`), so they
work with no bridge. When the game is in a multiplayer session and a
message is addressed to the game, it is typed into the game's own chat via
the bridge; steering messages to a playing agent go to the agent, not into
the game.

### 35. `GET /api/v1/chat` — `listChat`

```sh
curl -sS "$BASE/api/v1/chat"
```

Expect `200`, an array of chat messages (newest last), `[]` when none have
been sent.

### 36. `POST /api/v1/chat` — `sendChat`

`from` and `text` are required. `to` is optional — `null` (or omitted)
means broadcast.

```sh
# Broadcast a steering note to every agent:
curl -sS -X POST "$BASE/api/v1/chat" \
  -H 'Content-Type: application/json' \
  -d '{"from": "user", "text": "Hold the north corridor.", "to": null}'

# Direct a message at one agent:
curl -sS -X POST "$BASE/api/v1/chat" \
  -H 'Content-Type: application/json' \
  -d '{"from": "agent-2", "text": "Flanking from the east.", "to": "agent-1"}'
```

Expect `200` with the recorded message, echoing `from`, `text`, `to`, and
a server-assigned `ts` timestamp.

## Quick smoke run

```sh
# From the repo root, with the sidecar running (default port 8787):
#   cd server && npm install && npm run build && npm start
# Then, in another shell:
bash server/examples/rest-smoke.sh
# Add --include-wasm-swap to also exercise POST /api/v1/wasm/swap
# (it reloads the game page — see operation 26 above).
```

The script prints one `PASS`/`FAIL` line per operation (36 lines) plus a
summary, and exits 0 only when every check passes. Checks that need a bridge
accept `503 BRIDGE_OFFLINE` when none is connected, and say so in their
line — a `503` there is the spec working as documented, not a failure.
