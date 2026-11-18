<!-- SPDX-License-Identifier: MIT -->
# emsdk-setup.md — Emscripten SDK setup for the ROTT WASM build

Date: 2026-11-18. Emscripten 7.0.0 (SDK `6afbd83493d647051772d491124187d4e9a0cda9`).

## Local install (this lane)

```sh
cd <lane-dir>   # e.g. ~/workspace/rott-fleet/lane-1-wasm
git clone https://github.com/emscripten-core/emsdk.git emsdk
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
emcc --version   # emcc (Emscripten gcc/clang-like replacement) 7.0.0
```

Rolling targets: `install latest` follows Emscripten's latest release.
Never pin a version unless a build breaks and the user approves a pin.

## Quirk: tar ownership failure on this VM

The first `./emsdk install latest` failed unpacking Node:

```
tar: include/node/openssl/x509v3err.h: Cannot change ownership to uid 1000,
gid 1000: Operation not permitted
['tar', '-xf', '.../node-v24.19.0-linux-x64.tar.xz', '--strip', '1']
failed with error code 2
error: installation failed!
```

Cause: the VM runs in a user namespace where `tar` (as root) cannot
`chown` extracted files to uid 1000. Fix used by this lane: a `tar`
wrapper earlier in `PATH` that adds `--no-same-owner`:

```sh
# <lane-dir>/bin/tar
#!/bin/sh
exec /usr/bin/tar --no-same-owner "$@"
```

```sh
PATH="<lane-dir>/bin:$PATH" ./emsdk install latest
```

The wrapper is a local environment workaround for this VM only. It is
NOT part of the repo deliverables (it lives in the lane dir, not in
`outputs/`), and CI does not need it — GitHub runners unpack as the
runner user without this restriction. If a future local install hits
the same error, reuse the wrapper; if CI hits it, the runner image is
the problem, not this project.

## Verifying the install

```sh
source emsdk/emsdk_env.sh
emcc --version   # expect 7.0.0 (or newer, rolling)
node --version   # emsdk's bundled node (v24.x); the project Node (nvm
                 # v26.13.1) is separate and remains the Node for JS work
```

## CI

CI does not use a local emsdk: `.github/workflows/wasm.yml` clones
emsdk fresh on `ubuntu-latest` and runs `./emsdk install latest` on
every build. The local emsdk exists only for iteration. The canonical
build is CI.
