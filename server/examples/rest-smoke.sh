#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# REST smoke test for the ROTT sidecar — one request per OpenAPI operation
# (36 ops, 30 paths; see docs/openapi.yaml and docs/rest-examples.md).
#
# Usage:
#   bash server/examples/rest-smoke.sh [--base-url URL] [--include-wasm-swap]
#
# The sidecar must already be running (default port 8787):
#   cd server && npm install && npm run build && npm start
# Override the target with --base-url or ROTT_BASE_URL.
#
# Exit 0 when every check passes, 1 otherwise. Prints one PASS/FAIL/SKIP
# line per operation plus a summary.
#
# Bridge-dependent operations (input, screen, save/load, demo, mod/script
# reload, WASM swap, lifecycle, multiplayer) accept HTTP 503 BRIDGE_OFFLINE
# when no game page is connected — that is the spec working as documented,
# not a failure. Pure-sidecar operations (health, state, config, saves list,
# mod load/get/unload, script list/get/unregister, game info, chat) must
# return 200. See docs/rest-examples.md for which is which.
#
# The script is deliberately non-destructive where it can be: it saves to
# scratch slot 9, loads the example double-damage mod and unloads it again,
# registers a throwaway script and unregisters it again, and ends the
# lifecycle sequence at the main menu (new -> pause -> resume -> quit).
# POST /api/v1/wasm/swap is skipped by default because it reloads the game
# page; pass --include-wasm-swap to exercise it anyway.
set -euo pipefail

BASE="${ROTT_BASE_URL:-http://localhost:8787}"
INCLUDE_WASM_SWAP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url)
      BASE="${2:?--base-url needs a URL}"; shift 2 ;;
    --include-wasm-swap)
      INCLUDE_WASM_SWAP=1; shift ;;
    --help|-h)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done
BASE="${BASE%/}"

command -v curl >/dev/null 2>&1 || { echo "rest-smoke: curl is required" >&2; exit 2; }

TMPDIR_SMOKE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_SMOKE"' EXIT

PASS=0; FAIL=0; SKIP=0

# check <name> <method> <path> <expected-codes...> [--data <json>]
# Body (if any) follows the codes, as: --data '{"json": true}'
check() {
  local name="$1" method="$2" path="$3"; shift 3
  local -a expected=()
  while [ $# -gt 0 ] && [ "$1" != "--data" ]; do expected+=("$1"); shift; done
  local data=""
  if [ $# -gt 0 ] && [ "$1" == "--data" ]; then data="$2"; fi

  local body="$TMPDIR_SMOKE/body" code="" out=""
  if [ -n "$data" ]; then
    code="$(curl -sS -o "$body" -w '%{http_code}' -X "$method" \
      "$BASE$path" -H 'Content-Type: application/json' -d "$data" || echo "000")"
  else
    code="$(curl -sS -o "$body" -w '%{http_code}' -X "$method" \
      "$BASE$path" || echo "000")"
  fi
  # curl -w appends "000" on failure; keep only the trailing 3 digits.
  code="${code: -3}"

  local want
  for want in "${expected[@]}"; do
    if [ "$code" = "$want" ]; then
      PASS=$((PASS + 1))
      if [ "$code" = "503" ]; then
        echo "PASS $name ($method $path -> 503 bridge offline, as documented)"
      else
        echo "PASS $name ($method $path -> $code)"
      fi
      return 0
    fi
  done
  FAIL=$((FAIL + 1))
  echo "FAIL $name ($method $path -> $code, expected ${expected[*]})"
  out="$(head -c 300 "$body" 2>/dev/null || true)"
  [ -n "$out" ] && echo "     body: $out"
  return 0
}

skip() { SKIP=$((SKIP + 1)); echo "SKIP $1 ($2)"; }

# --- Preflight: the sidecar must be reachable at all. ---
if ! curl -sS -o /dev/null --max-time 5 "$BASE/health"; then
  echo "rest-smoke: cannot reach the sidecar at $BASE/health" >&2
  echo "rest-smoke: start it first: cd server && npm install && npm run build && npm start" >&2
  exit 2
fi

# --- Health / State (work with no bridge) ---
check "getHealth"       GET  /health                    200
check "getState"        GET  /api/v1/state              200

# --- Screen: PNG when bridged, 503 without a bridge. ---
SCREEN_BODY="$TMPDIR_SMOKE/screen.png"
SCREEN_CODE="$(curl -sS -o "$SCREEN_BODY" -w '%{http_code}' \
  "$BASE/api/v1/screen" || echo "000")"
SCREEN_CODE="${SCREEN_CODE: -3}"
if [ "$SCREEN_CODE" = "200" ]; then
  if command -v file >/dev/null 2>&1 && file "$SCREEN_BODY" | grep -qi 'PNG image'; then
    PASS=$((PASS + 1)); echo "PASS getScreen (GET /api/v1/screen -> 200, PNG image)"
  elif [ -s "$SCREEN_BODY" ]; then
    PASS=$((PASS + 1)); echo "PASS getScreen (GET /api/v1/screen -> 200, non-empty body; 'file' unavailable to confirm PNG)"
  else
    FAIL=$((FAIL + 1)); echo "FAIL getScreen (GET /api/v1/screen -> 200 but empty body)"
  fi
elif [ "$SCREEN_CODE" = "503" ]; then
  PASS=$((PASS + 1)); echo "PASS getScreen (GET /api/v1/screen -> 503 bridge offline, as documented)"
else
  FAIL=$((FAIL + 1)); echo "FAIL getScreen (GET /api/v1/screen -> $SCREEN_CODE, expected 200 or 503)"
fi

# --- Input (bridge required) ---
check "sendKey"         POST /api/v1/input/key          200 503 --data '{"key": "ArrowUp", "action": "press", "holdMs": 50}'
check "sendMouse"       POST /api/v1/input/mouse        200 503 --data '{"x": 320, "y": 200, "button": "left", "action": "click"}'
check "sendText"        POST /api/v1/input/text         200 503 --data '{"text": "PLAYER1"}'
check "sendInputSequence" POST /api/v1/input/sequence   200 503 --data '{"events": [{"key": {"key": "Escape", "action": "press"}, "delayMs": 100}, {"key": {"key": "Enter", "action": "press"}}]}'

# --- Config (works with no bridge; PUT reports bridge-offline in pendingReload) ---
check "getConfig"       GET  /api/v1/config             200
check "putConfig"       PUT  /api/v1/config             200 --data '{"video": {"resolution": "640x400", "fullscreen": false}, "audio": {"musicVolume": 70, "sfxVolume": 80}, "difficulty": "normal", "options": {"crosshair": true}}'
check "getConfigSection:video"      GET /api/v1/config/video      200
check "getConfigSection:audio"      GET /api/v1/config/audio      200
check "getConfigSection:controls"   GET /api/v1/config/controls   200
check "getConfigSection:difficulty" GET /api/v1/config/difficulty 200
check "getConfigSection:options"    GET /api/v1/config/options    200

# --- Saves (list works with no bridge; save/load need one; load may 404 on an empty slot) ---
check "listSaves"       GET  /api/v1/saves              200
check "saveGame"        POST /api/v1/save               200 503 --data '{"slot": 9, "label": "rest-smoke scratch"}'
check "loadGame"        POST /api/v1/load               200 404 503 --data '{"slot": 9}'

# --- Demo (bridge required) ---
check "playDemo"        POST /api/v1/demo/play          200 503 --data '{"demo": "DEMO1_3", "loop": false}'
check "stopDemo"        POST /api/v1/demo/stop          200 503

# --- Mods (load/get/unload work with no bridge; reload needs one) ---
check "listMods"        GET  /api/v1/mods               200
check "loadMod"         POST /api/v1/mods               200 --data '{"id": "double-damage", "name": "Double Damage (example)", "version": "0.1.0", "description": "Example data-driven mod.", "enabled": true, "weapons": {"Pistol": {"damage": 40}}, "enemies": {"Guard": {"health": 120}}, "levels": {"E1L1": {"extraHealthPickups": 4}}, "wadOverlays": []}'
check "getMod"          GET  /api/v1/mods/double-damage 200
check "reloadMod"       POST /api/v1/mods/double-damage/reload 200 503
check "unloadMod"       DELETE /api/v1/mods/double-damage 200

# --- Scripts (register/reload need a bridge; list/get/unregister do not) ---
check "listScripts"     GET  /api/v1/scripts            200
SCRIPT_BODY="$TMPDIR_SMOKE/script-body"
SCRIPT_CODE="$(curl -sS -o "$SCRIPT_BODY" -w '%{http_code}' -X POST \
  "$BASE/api/v1/scripts" -H 'Content-Type: application/json' \
  -d '{"name": "rest-smoke-watch", "code": "function onTick(state) { if (state.health !== null && state.health < 30) { RottBridge.sendKey({key: \"Escape\", action: \"press\"}); } }", "enabled": true}' || echo "000")"
SCRIPT_CODE="${SCRIPT_CODE: -3}"
if [ "$SCRIPT_CODE" = "200" ]; then
  PASS=$((PASS + 1)); echo "PASS registerScript (POST /api/v1/scripts -> 200)"
  check "getScript"     GET  /api/v1/scripts/rest-smoke-watch 200
  check "reloadScript"  POST /api/v1/scripts/rest-smoke-watch/reload 200 503
  check "unregisterScript" DELETE /api/v1/scripts/rest-smoke-watch 200
elif [ "$SCRIPT_CODE" = "503" ]; then
  PASS=$((PASS + 1)); echo "PASS registerScript (POST /api/v1/scripts -> 503 bridge offline, as documented)"
  skip "getScript" "needs a registered script (register returned 503)"
  skip "reloadScript" "needs a registered script (register returned 503)"
  skip "unregisterScript" "needs a registered script (register returned 503)"
else
  FAIL=$((FAIL + 1)); echo "FAIL registerScript (POST /api/v1/scripts -> $SCRIPT_CODE, expected 200 or 503)"
  skip "getScript" "registerScript failed"
  skip "reloadScript" "registerScript failed"
  skip "unregisterScript" "registerScript failed"
fi

# --- Lifecycle (bridge required, except game info) ---
check "getGameInfo"     GET  /api/v1/game/info         200
check "newGame"         POST /api/v1/game/new           200 503 --data '{"episode": 1, "level": 1, "difficulty": "normal"}'
check "pauseGame"       POST /api/v1/game/pause        200 503
check "resumeGame"      POST /api/v1/game/resume       200 503
check "quitGame"        POST /api/v1/game/quit         200 503

# --- Multiplayer (bridge required; join may 400 on an unreachable host) ---
check "hostMultiplayer" POST /api/v1/multiplayer/host  200 503 --data '{"mode": "comm-bat", "maxPlayers": 4, "episode": 1, "level": 1}'
check "joinMultiplayer" POST /api/v1/multiplayer/join  200 400 503 --data '{"address": "127.0.0.1", "playerName": "rest-smoke"}'
check "leaveMultiplayer" POST /api/v1/multiplayer/leave 200 503

# --- Chat (works with no bridge) ---
check "sendChat"        POST /api/v1/chat               200 --data '{"from": "rest-smoke", "text": "Smoke test message.", "to": null}'
check "listChat"        GET  /api/v1/chat               200

# --- WASM swap: opt-in only — it reloads the game page. ---
if [ "$INCLUDE_WASM_SWAP" = "1" ]; then
  check "swapWasm"      POST /api/v1/wasm/swap          200 503 --data '{"moduleUrl": "http://localhost:8080/rott.wasm", "saveSlot": 9}'
else
  skip "swapWasm" "pass --include-wasm-swap to exercise it (it reloads the game page)"
fi

echo "rest-smoke: PASS $PASS / FAIL $FAIL / SKIP $SKIP (base $BASE)"
[ "$FAIL" -eq 0 ]
