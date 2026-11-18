# Shareware game data (`data/shareware/`)

This directory holds the nine **shareware game-data files** for
*Rise of the Triad* (1994, Apogee Software) — the data the GPL engine in
`src/` (and its WASM build) needs to run the shareware episode.

## Provenance

These files come from the ROTT shareware release (v1.3), released for free
distribution as shareware. They were copied from the lane-1 WASM workspace
`data-shareware/` set.

**Registered game data is NOT included and must NEVER be committed to this
repo** (repo `AGENTS.md` rule): `DARKWAR.WAD`, `DARKWAR.RTC`, `DARKWAR.RTL`,
`DARKWAR.RTS` — the registered episode's data files — do not belong here.

## Files

| File | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `DEMO1_3.DMO` | 27,028 | `b57b2a1d5c72f6a9b2761537340969b297af16b14dbc284794a71163bc6c50a0` |
| `DEMO2_3.DMO` | 34,360 | `ed18246749adb5f3834ff8043028c25e0c1059f37679dd86756338e4ef5d90f3` |
| `DEMO3_3.DMO` | 47,704 | `bd0400207df98d92774db3f92a924ebc1d53f6dce216101df931fd5c6cffb3a4` |
| `DEMO4_3.DMO` | 36,412 | `e30b0dfe205a59b2da17fe1a577a4bda2745160898d747b2e0169fcc3fc3ab67` |
| `HUNTBGIN.RTC` | 54,258 | `a914e8c120d67801969582f44a4ba117f088904714ee6101c6d64a4a86f51146` |
| `HUNTBGIN.RTL` | 103,316 | `96fd5f16735b75151a7a1878ad77b653883fb53f0462b5dd231f6e841a35bfee` |
| `HUNTBGIN.WAD` | 6,436,871 | `863212c2c9af490271f32487e333c44de71f4f368d93e887181d4f7d9525e893` |
| `REMOTE1.RTS` | 110,484 | `7901e0102436b3d153a747e1d7b7fe18a4af113701e4dc9ba4764fb997d7d88b` |
| `VENDOR.DOC` | 7,752 | `a8a73af0f5f46e975d005becfac692c48c097dc43b9230a32c0734801c9df701` |

Total: 6,858,185 bytes. Checksums verified locally 2026-11-18.

What each file is:

- `HUNTBGIN.WAD` — the main shareware game data (levels, textures,
  sprites, sounds).
- `HUNTBGIN.RTC` / `HUNTBGIN.RTL` — game data tables.
- `DEMO1_3.DMO`–`DEMO4_3.DMO` — recorded demo playbacks.
- `REMOTE1.RTS` — remote-ridicule / multiplayer data file.
- `VENDOR.DOC` — the shareware vendor/distribution notice.

## How the WASM build consumes them

`Makefile.emcc` (repo root) uses `--preload-file data/shareware` to bundle
these files into the Emscripten virtual filesystem at build time; the engine
reads them from the VFS at runtime. The CI workflow
`.github/workflows/wasm.yml` runs a `validate-data` step that fails until
these files are present.

## Verifying the files

After uploading or checking out, compare the output of:

```sh
sha256sum data/shareware/*
```

against the table above — every hash must match.

## Licensing boundary

These data files are shareware game data, **not code**. They are not covered
by the repo's MIT sidecar license, nor by the engine's GPL-2.0. They are
distributed under the original shareware terms (free distribution). No `src/`
engine file was touched by this lane.

## Upload note

The nine binary files were staged locally and uploaded via the GitHub web UI:
the API connector is text/UTF-8 only and cannot push binary files.
