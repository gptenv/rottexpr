<!-- SPDX-License-Identifier: MIT -->
# Script layer — hot-reloadable example (`scripts/`)

The script layer is the sidecar's way to run small game-logic programs
without touching the engine and without restarting the game. Scripts are
plain JS that runs in the page's JS context, **outside** the WASM module,
and drives the game only through the bridge — synthetic keyboard/mouse
input in, screen and save observation out. This directory holds one
worked example, `example-script.js`, and this README documents how the
layer works and where it stops.

## The example: `example-script.js`

A gentle "patrol" autopilot, registered under the name
`example-script`:

- While the game reports `status === "playing"`, it walks forward in
  short bursts and turns left/right on alternate moves (one key press
  every ~2 s, so presses can never overlap).
- It logs when the screen hash changes and when the visible health or
  score changes.
- It never fires, never opens menus, never saves or loads, and never
  touches engine internals.
- On load it notes whether the `double-damage` example mod
  (`mods/example-mod`) is active, by reading its JSON overrides from
  `ctx.modValues` — reading mod values is optional; the script works the
  same with no mod loaded.

## How the script layer works

1. **Registration.** The sidecar (`server/src/scripts.ts`) validates the
   script — name must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`, code must be a
   non-empty string under 1 MiB — stores it, and sends `{name, code}` to
   the bridge over the bridge WebSocket (`script.register`).
2. **Evaluation.** The bridge (`bridge/rott-bridge.js`,
   `registerScript`) evaluates the code in the page context with
   `new Function("ctx", code + ";return RottScript")`, passing
   `ctx = { bridge, log, modValues }`:
   - `bridge` — the script API (same functions as `onTick`'s second
     argument; see below).
   - `log` — the bridge's log function (writes `[rott-bridge] ...` to
     the page console).
   - `modValues` — `window.RottModValues`, the JSON overrides of every
     loaded data-driven mod, keyed by mod id.
   The code must define a top-level `RottScript` object (a `var` at the
   top of the file works: the bridge reads it back from inside the same
   `Function` scope). If evaluation throws, registration fails and the
   error is returned; nothing is half-registered.
3. **Hooks.** The bridge calls exactly two hooks:
   - `onLoad(api)` — once, at registration, with the bridge API. Keep
     it side-effect free apart from logging: a throwing `onLoad` fails
     registration.
   - `onTick(state, api)` — every 500 ms, with the observed state (see
     below) and the bridge API. An `onTick` that throws is logged
     (`script '<name>' onTick error: ...`) and the script keeps running;
     the next tick still fires.
4. **Hot reload.** Re-registering the same name replaces the stored
   source and re-evaluates it in place; `POST
   /api/v1/scripts/{name}/reload` re-evaluates the currently stored
   source. Either way the game is **not** restarted and no save/load
   cycle happens. Edit the file, re-register, and the new behaviour is
   live on the next tick.

### The bridge API given to scripts

| Function | What it does |
|---|---|
| `api.key(key, holdMs)` | Press a key (`"ArrowUp"`, `"Control"`, `"Space"`, `"Escape"`, `"1"`–`"9"`, ...) — key down, hold `holdMs` (default 50 ms), key up — dispatched to the canvas and `window`, exactly as a human keypress arrives. |
| `api.mouse(x, y, action)` | Mouse at page coordinates; `action` is `"click"` (default), `"move"`, `"down"`, or `"up"`. |
| `api.text(text)` | Type text as a chain of key presses. (The game has no chat/console input, so this is for menus, not for talking.) |
| `api.observe()` | Promise of the observed state (below). |
| `api.capture()` | Promise of a screenshot (data URL) via the bridge's rAF capture. |
| `api.save(slot)` | Drive the game's own save menu (F2, slot digit, confirm) into slot 0–9. Opens menus — do not call it on a timer. |
| `api.load(slot)` | Drive the load menu (F3, ...) for slot 0–9. Same warning as `save`. |

### The `state` passed to `onTick`

From the bridge's `observe()`: `status` (`"menu" | "playing" |
"paused" | "demo" | "loading"`), `bridgeConnected`, `episode`,
`level`, `levelName`, `difficulty`, `health`, `armor`, `ammo`,
`weapons`, `score`, `lives`, `screenHash`, `screenCapturedAt`,
`hudText`, `saveSlots`, `canvasWidth`, `canvasHeight`, `updatedAt`.
The HUD numbers come from `window.RottStatus`, which the page shell
fills in only when it can read them off the screen — **any of them may
be `null`**. Treat a `null` as "unknown", never as zero.

## Using the example

Prerequisites: the sidecar is running (`http://localhost:8787` by
default) and the game page is open with the bridge connected. Register
the example:

```sh
# Register (or replace) the example script. The file contents become
# the JSON `code` field; python builds the request so no quoting breaks.
python3 -c "
import json, urllib.request
code = open('scripts/example-script.js').read()
req = urllib.request.Request(
    'http://localhost:8787/api/v1/scripts',
    data=json.dumps({'name': 'example-script', 'code': code}).encode(),
    headers={'Content-Type': 'application/json'}, method='POST')
print(urllib.request.urlopen(req).read().decode())
"
```

Then watch the page console (`[rott-bridge]` / `[example-script]` lines)
and the game: the player should wander while the game is playing and do
nothing in menus. Other endpoints:

```sh
curl http://localhost:8787/api/v1/scripts                    # list scripts
curl http://localhost:8787/api/v1/scripts/example-script     # get one script
curl -X POST http://localhost:8787/api/v1/scripts/example-script/reload
curl -X DELETE http://localhost:8787/api/v1/scripts/example-script
```

To iterate: edit `scripts/example-script.js`, re-run the register
command above (same name replaces the running copy), and the new
behaviour is live on the next tick — no game restart, no page reload.

## Limits — read before writing a script

- **Player layer only.** A script sees what a human player sees (the
  screen, the HUD, save files) and does what a human player does
  (keyboard/mouse). It cannot read WASM memory, engine state, enemy
  positions, or the map; it cannot call Emscripten internals (`Module`,
  `FS`, `HEAP`); it cannot modify the engine. If a feature needs engine
  internals, the script layer cannot do it — build the closest version
  on public interfaces or skip it.
- **No exact live state.** Health, ammo, score and friends are only
  known when the page shell exposes them via `window.RottStatus`; expect
  `null`s. Do not dead-reckon from assumed positions — poll screenshots
  and state instead. The game runs at its own frame rate under ASYNCIFY;
  `onTick`'s 500 ms cadence is not the game tick.
- **`onEvent` is not called.** The OpenAPI `Script` schema names
  `onTick`, `onEvent`, and `onLoad`, but bridge v1.0.0 only invokes
  `onLoad` and `onTick`. Do not rely on `onEvent` — poll `state` in
  `onTick` instead. (If a later bridge wires `onEvent` up, scripts that
  define it will start receiving events with no change needed.)
- **Input is best-effort in places.** Keyboard turning always works;
  mouse-look needs pointer lock, which a synthetic click cannot obtain
  — a human click on the canvas is needed first, and `movementX/Y` on
  synthetic mousemove events are honoured only while pointer lock is
  held. Screenshots need the rAF capture path (see
  `docs/BRIDGE-CONTRACT.md`); a screenshot taken from a timer may come
  back blank.
- **Keys act on menus too.** Only press keys when
  `state.status === "playing"` unless the script is deliberately driving
  a menu. `save()`/`load()` open the game's menus by design — never call
  them from `onTick` on a timer.
- **No imports, no modules.** Scripts are evaluated with `new Function`,
  not loaded as ES modules: no `import`/`export`, no top-level `await`,
  no `require`. Keep it plain JS (the bridge itself is ES5-style; this
  example is too). `ctx` is only defined during bridge evaluation —
  guard any use of it, as the example does, so the file still loads
  standalone.
- **Trust boundary.** Script code runs with the page's privileges and is
  only as safe as its author. Register scripts only from sources you
  trust; the sidecar does no sandboxing beyond the bridge API.
- **Size and naming.** Code is capped at 1 MiB; names must match
  `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. Registration returns 503 when no bridge
  is connected — open the game page first.

## Where this fits

- Bridge contract: `docs/BRIDGE-CONTRACT.md` (the DOM interface the
  script layer drives through).
- Bridge implementation: `bridge/rott-bridge.js` (`registerScript`,
  `makeScriptApi`, the 500 ms `onTick` loop).
- Sidecar registry + REST endpoints: `server/src/scripts.ts`,
  `server/src/handlers.ts`, `docs/openapi.yaml` (`/api/v1/scripts*`,
  `Script` schema).
- Related examples: `mods/example-mod/` (data-driven mod whose values
  this script can read via `ctx.modValues`).
