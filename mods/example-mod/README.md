<!-- SPDX-License-Identifier: MIT -->
# Example mod: `double-damage`

A minimal data-driven mod for the ROTT sidecar, showing the mod format.
It is JSON + notes only: no code, no WAD overlay files, no engine changes.

## What it does

- **Pistol damage 40** (roughly double the stock value).
- **Guard health 120** (first guards take about one more pistol hit).
- **E1L1: 4 extra health pickups.**

## How it is applied

```
POST /api/v1/mods
Content-Type: application/json

<contents of mod.json>
```

The sidecar registers the manifest and the bridge applies it:

1. The JSON overrides land in `window.RottModValues["double-damage"]`,
   where the script layer can read them immediately.
2. If the mod listed `wadOverlays`, the sidecar reads those files from
   `server/data/mods/<id>/` and the bridge writes them into the game's
   data directory via the Emscripten FS. This example lists none.
3. Values the engine only reads at load time (weapon/enemy stats baked
   into level data) take effect on the next level load. The sidecar never
   claims an instant engine change.

## Unload / reload

```
DELETE /api/v1/mods/double-damage          # unload
POST   /api/v1/mods/double-damage/reload   # hot-reload after editing mod.json
```

## Adding a WAD overlay

1. Put the overlay file in `server/data/mods/<id>/`, e.g.
   `server/data/mods/double-damage/DOUBLE.WAD`.
2. Add its bare filename to `wadOverlays` in `mod.json`.
3. Load (or reload) the mod. The bridge installs the file; the engine
   reads it as an overlay on the next load.

Never commit registered game data (`DARKWAR.*`) as a mod overlay. Only
shareware data and files you created yourself belong in a mod.
