// SPDX-License-Identifier: MIT
// ROTT bridge — page-side, plain JS. The ONLY thing that touches the running
// game. It sees what a human player sees (screen + HUD) and does what a
// human player does (keyboard + mouse). It talks to the game ONLY through
// interfaces the game already has: synthetic DOM input events into the
// canvas, canvas screenshots, the game's own save/config/data files, and
// its existing network protocol. It never modifies the engine, never
// compiles code into the WASM module, never reads WASM memory.
//
// The bridge connects back to the sidecar server over WebSocket
// (ws://<sidecar-host>:8787/bridge) and answers JSON requests
// {id, method, params} with {id, ok, result|error}.
//
// Integration points, RECONCILED to docs/BRIDGE-CONTRACT.md (L15) —
// see bridge/README.md for the full reconciliation list. Headlines:
//  - The game canvas is #rott-canvas (contract section 1; web/index.html).
//  - Save files are rottgam<hex>.rot, 14 slots 0-13 (engine: rt_menu.c
//    SaveName="rottgam?.rot", NUMSAVEGAMES=14, hex slot digit). The
//    contract's "SAVEGAM?.ROT" does not exist in the engine. rottgamf.rot
//    is the quicksave backup, not a menu slot.
//  - Engine config is lowercase config.rot (rt_cfg.c) and is engine-native
//    binary: the bridge NEVER writes it. Bridge-side JSON goes to
//    rott-bridge.json in the save dir instead.
//  - Save/load go through the real menus: Esc, main-menu hotkey 's' (save)
//    / 'r' (restore), slot hotkey 'a'+slot (slots 0-13), Enter to confirm
//    an overwrite, then the name prompt. F2/F3 do NOT save/load in-game:
//    F2-F10 are RemoteRidicule taunts (rt_main.c); F6 is quicksave.
//    Pause is the Pause/Break key, not "P" (rt_in.c: SDLK_PAUSE).
//  - window.Module.FS, when the page exposes it, is the bridge's file
//    path (save listing, bridge config, WAD overlays) plus FS.syncfs for
//    the IDBFS sync the contract requires. The bridge never touches WASM
//    memory/HEAP. Set useModuleFS:false to run menus/screen only.
//  - window.RottStatus (optional): the page shell may set an object with
//    {status, episode, level, levelName, difficulty, health, armor, ammo,
//    weapons, score, lives, hudText} for observe() to merge in. When
//    window.ROTT exists (contract section 2) the bridge prefers its
//    getStatus()/screenshot().
//  - ?wasm=<url> / ?load=<slot> (module hot-swap) are honoured only if the
//    page shell implements them; lane 1's web/app.js as written loads a
//    fixed rott.js path and does NOT read them. See README.
//  - Emscripten should be built with preserveDrawingBuffer or the bridge
//    falls back to a rAF drawImage capture (see captureScreen).

(function (global) {
  "use strict";

  var VERSION = "1.1.0"; // reconciled to BRIDGE-CONTRACT.md (lane L15)
  var DEFAULT_SIDECAR = "ws://localhost:8787/bridge";

  // The engine has 14 save slots (NUMSAVEGAMES, src/_rt_menu.h).
  var NUM_SAVE_SLOTS = 14;

  function defaults() {
    return {
      sidecarUrl: DEFAULT_SIDECAR,
      // Contract section 1: the canvas is #rott-canvas (640x400).
      canvas: "#rott-canvas",
      // Menu keys, verified against the engine (see bridge/README.md):
      //  - quicksave "F6": rt_main.c — opens the save menu when no
      //    quicksave slot exists yet, else quick-saves to that slot.
      //    There is NO quickload key; loading is menu-only.
      //  - pause "Pause": the Pause/Break key (rt_in.c: SDLK_PAUSE).
      //    "P" does nothing in the engine.
      //  - menu "Escape" / confirm "Enter": the menu keys (contract
      //    section 2: menu navigation is arrows + Enter).
      //  - chat "t": UNCONFIRMED placeholder. The engine has no free-text
      //    chat input (contract section 2: "No text injection"); its
      //    multiplayer messages are the F2-F10 RemoteRidicule taunts.
      //    Override via configure() if the page shell provides chat.
      keys: {
        quicksave: "F6",
        pause: "Pause",
        menu: "Escape",
        confirm: "Enter",
        chat: "t",
      },
      // Menu key sequences. Each entry is a key or {key, delayMs}.
      // Grounded in the engine's menu hotkeys (rt_menu.c MainMenu/LSMenu):
      // main menu 'n' new game, 'c' Comm-bat, 'r' restore, 's' save;
      // save/load slots are hotkeys 'a'..'n' (slots 0..13). Anything
      // beyond the first menu level is best-effort; override via
      // RottBridge.configure().
      menuSequences: {
        newGame: ["Escape", "n"],
        quitToMenu: ["Escape"],
        hostGame: ["Escape", "c"],
        joinGame: ["Escape", "c"],
        leaveGame: ["Escape"],
      },
      // Emscripten FS paths (only used when window.Module.FS exists and
      // useModuleFS is true). saveDir is the shareware dir; registered
      // builds use <saveDir>/darkwar — resolveSaveDir() detects it.
      // configFile is the BRIDGE's own JSON file, NOT the engine's
      // config.rot (lowercase, engine-native binary — never written).
      saveDir: "/home/web_user/.rott",
      registeredSaveDir: "/home/web_user/.rott/darkwar",
      configFile: "/home/web_user/.rott/rott-bridge.json",
      dataDir: "/",
      useModuleFS: true,
      reconnectMs: 3000,
    };
  }

  var options = defaults();
  var socket = null;
  var reconnectTimer = null;
  var status = "menu"; // best-effort: menu | playing | paused | demo | loading
  var lastScreenHash = null;
  var saveSlotsCache = [];
  var scripts = {}; // name -> {code, fn, enabled, updatedAt}
  var scriptTimer = null;

  // ---------------------------------------------------------------- utils

  function log() {
    if (typeof console !== "undefined" && console.log) {
      console.log.apply(console, ["[rott-bridge]"].concat(Array.prototype.slice.call(arguments)));
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function getCanvas() {
    if (typeof options.canvas === "string") return document.querySelector(options.canvas);
    return options.canvas || null;
  }

  function getFS() {
    // Only when the Emscripten build exposes its FS on the page AND the
    // operator left useModuleFS on (configure({useModuleFS: false}) runs
    // menus/screen only). The bridge never reaches into the WASM module
    // itself — FS is the game's own file interface, the same one the
    // engine uses for saves/config/data. It never touches HEAP or WASM
    // memory. (Contract boundary vs section 3 tension: see README.)
    if (!options.useModuleFS) return null;
    if (global.Module && global.Module.FS) return global.Module.FS;
    return null;
  }

  // The engine writes saves/config under $HOME/.rott/ for shareware and
  // $HOME/.rott/darkwar/ for registered (dosutil.c setup_homedir; contract
  // section 3; web/rott-pre.js). Detect which dir is in use when the FS
  // is exposed; otherwise fall back to the configured saveDir. The
  // configured saveDir always wins if the operator overrode it.
  function resolveSaveDir() {
    var FS = getFS();
    if (FS && options.saveDir === defaults().saveDir) {
      try {
        var names = FS.readdir(options.saveDir);
        if (names && names.indexOf("darkwar") !== -1) return options.registeredSaveDir;
      } catch (e) { /* fall through to the shareware dir */ }
    }
    return options.saveDir;
  }

  // Contract section 3: a save written by the game may take up to ~30 s
  // to reach IndexedDB (or until the page hides). If the bridge needs a
  // save *now*, it triggers a sync through the page's FS.syncfs path —
  // the same path web/rott-pre.js uses.
  function syncFiles() {
    var FS = getFS();
    if (!FS || typeof FS.syncfs !== "function") {
      return Promise.resolve({ synced: false, reason: "no FS exposed" });
    }
    return new Promise(function (resolve) {
      try {
        FS.syncfs(false, function (err) {
          resolve({ synced: !err, error: err ? String(err) : null });
        });
      } catch (e) {
        resolve({ synced: false, error: e && e.message ? e.message : String(e) });
      }
    });
  }

  function fnv1a(str) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return ("0000000" + hash.toString(16)).slice(-8);
  }

  // ------------------------------------------------------------ input

  function keyCodeFor(key) {
    // Minimal map for the keys ROTT menus/gameplay need. Unknown keys get
    // a best-effort code derived from the key name.
    var map = {
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
      Enter: 13, Escape: 27, " ": 32, Tab: 9, Backspace: 8,
      Shift: 16, Control: 17, Alt: 18, Pause: 19, F1: 112, F2: 113, F3: 114,
      F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121,
    };
    if (map[key] !== undefined) return map[key];
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
    return 0;
  }

  function dispatchKey(target, type, key, code) {
    var event;
    try {
      event = new KeyboardEvent(type, {
        key: key,
        code: code || "",
        keyCode: keyCodeFor(key),
        which: keyCodeFor(key),
        bubbles: true,
        cancelable: true,
      });
    } catch (e) {
      event = document.createEvent("Event");
      event.initEvent(type, true, true);
      event.key = key;
      event.keyCode = keyCodeFor(key);
      event.which = keyCodeFor(key);
    }
    target.dispatchEvent(event);
  }

  function dispatchMouse(target, type, x, y, button, movement) {
    var event;
    var rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0 };
    try {
      event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + x,
        clientY: rect.top + y,
        button: button === "right" ? 2 : button === "middle" ? 1 : 0,
        buttons: type === "mousemove" ? 0 : 1,
      });
    } catch (e) {
      event = document.createEvent("Event");
      event.initEvent(type, true, true);
      event.clientX = rect.left + x;
      event.clientY = rect.top + y;
      event.button = button === "right" ? 2 : 0;
    }
    // Contract section 2: movementX/movementY are defined on the event
    // when supplied (pointer-lock deltas). They are honoured only while
    // pointer lock is held, which a synthetic click cannot obtain — so
    // mouse-look driving stays best-effort; keyboard turning always works.
    if (movement && (typeof movement.movementX === "number" || typeof movement.movementY === "number")) {
      try {
        if (typeof movement.movementX === "number") {
          Object.defineProperty(event, "movementX", { value: movement.movementX });
        }
        if (typeof movement.movementY === "number") {
          Object.defineProperty(event, "movementY", { value: movement.movementY });
        }
      } catch (e) { /* read-only event property on this browser; continue without it */ }
    }
    target.dispatchEvent(event);
  }

  function sendKey(input) {
    var canvas = getCanvas();
    if (!canvas) throw new Error("No game canvas found.");
    var key = input.key;
    var code = input.code || "";
    var action = input.action || "press";
    var holdMs = typeof input.holdMs === "number" ? input.holdMs : 50;
    var targets = [canvas, window];
    function down() { targets.forEach(function (t) { dispatchKey(t, "keydown", key, code); }); }
    function up() { targets.forEach(function (t) { dispatchKey(t, "keyup", key, code); }); }
    if (action === "down") { down(); return Promise.resolve({ accepted: true }); }
    if (action === "up") { up(); return Promise.resolve({ accepted: true }); }
    down();
    return sleep(holdMs).then(function () { up(); return { accepted: true }; });
  }

  function sendMouse(input) {
    var canvas = getCanvas();
    if (!canvas) throw new Error("No game canvas found.");
    var button = input.button || "left";
    var action = input.action;
    var movement = { movementX: input.movementX, movementY: input.movementY };
    if (action === "move") {
      dispatchMouse(canvas, "mousemove", input.x, input.y, button, movement);
      dispatchMouse(window, "mousemove", input.x, input.y, button, movement);
    } else if (action === "down") {
      dispatchMouse(canvas, "mousedown", input.x, input.y, button);
    } else if (action === "up") {
      dispatchMouse(canvas, "mouseup", input.x, input.y, button);
    } else {
      dispatchMouse(canvas, "mousedown", input.x, input.y, button);
      dispatchMouse(canvas, "mouseup", input.x, input.y, button);
      dispatchMouse(canvas, "click", input.x, input.y, button);
    }
    return Promise.resolve({ accepted: true });
  }

  function sendText(text) {
    var chain = Promise.resolve();
    for (var i = 0; i < text.length; i++) {
      (function (ch) {
        chain = chain.then(function () { return sendKey({ key: ch, action: "press", holdMs: 30 }); });
      })(text[i]);
    }
    return chain.then(function () { return { accepted: true }; });
  }

  function runSequence(events) {
    var chain = Promise.resolve();
    var executed = 0;
    events.forEach(function (event) {
      chain = chain.then(function () {
        var step;
        if (event.key) step = sendKey(event.key);
        else if (event.mouse) step = sendMouse(event.mouse);
        else if (event.text) step = sendText(event.text.text || "");
        else step = Promise.resolve();
        executed++;
        return step.then(function () { return sleep(event.delayMs || 0); });
      });
    });
    return chain.then(function () { return { accepted: true, executed: executed }; });
  }

  function runMenuSequence(name) {
    var seq = options.menuSequences[name] || [];
    var events = seq.map(function (entry) {
      if (typeof entry === "string") return { key: { key: entry, action: "press" }, delayMs: 150 };
      return { key: { key: entry.key, action: "press" }, delayMs: entry.delayMs || 150 };
    });
    return runSequence(events);
  }

  // ------------------------------------------------------------ screen

  function captureScreen() {
    var canvas = getCanvas();
    if (!canvas) throw new Error("No game canvas found.");
    // Draw the WebGL canvas into a 2D canvas inside rAF: without
    // preserveDrawingBuffer a direct toDataURL() can return a blank frame.
    // When the page shell provides window.ROTT (contract section 2), use
    // its screenshot() first — it already handles the rAF rule — and fall
    // back to drawImage when it returns null.
    return new Promise(function (resolve, reject) {
      function grab() {
        try {
          var rott = global.ROTT;
          if (rott && typeof rott.screenshot === "function") {
            var shot = null;
            try { shot = rott.screenshot(); } catch (e) { shot = null; }
            if (shot) {
              var hash = fnv1a(shot);
              lastScreenHash = hash;
              resolve({ pngBase64: shot.split(",")[1], hash: hash });
              return;
            }
          }
          var off = document.createElement("canvas");
          off.width = canvas.width;
          off.height = canvas.height;
          var ctx = off.getContext("2d");
          if (!ctx) throw new Error("No 2D context for capture.");
          ctx.drawImage(canvas, 0, 0);
          var dataUrl = off.toDataURL("image/png");
          var hash2 = hashCanvas(off, ctx);
          lastScreenHash = hash2;
          resolve({ pngBase64: dataUrl.split(",")[1], hash: hash2 });
        } catch (e) {
          reject(e);
        }
      }
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(grab);
      else grab();
    });
  }

  // Hash of an all-black frame, for the liveness check in waitForGame():
  // the contract's liveness signal is "canvas has non-black pixels".
  function blackScreenHash() {
    var small = document.createElement("canvas");
    small.width = 32;
    small.height = 18;
    var sctx = small.getContext("2d");
    if (!sctx) return null;
    sctx.fillStyle = "#000";
    sctx.fillRect(0, 0, 32, 18);
    var data = sctx.getImageData(0, 0, 32, 18).data;
    var str = "";
    for (var i = 0; i < data.length; i += 16) {
      str += String.fromCharCode(data[i] >> 4, data[i + 1] >> 4, data[i + 2] >> 4);
    }
    return fnv1a(str);
  }

  // Contract section 1: the bridge must wait for the game to exist before
  // driving it — poll window.ROTT + #rott-canvas, and treat "canvas has
  // non-black pixels" as the liveness signal. Resolves (never rejects)
  // with {ready, live, hash}; ready=false means the timeout elapsed.
  function waitForGame(timeoutMs) {
    var timeout = typeof timeoutMs === "number" ? timeoutMs : 10000;
    var started = Date.now();
    return new Promise(function (resolve) {
      function poll() {
        var canvas = getCanvas();
        var rottReady = !!(global.ROTT && canvas);
        if (!rottReady) {
          if (Date.now() - started >= timeout) return resolve({ ready: false, live: false, hash: null });
          return setTimeout(poll, 250);
        }
        captureScreen().then(function (shot) {
          var black = blackScreenHash();
          resolve({ ready: true, live: black === null ? null : shot.hash !== black, hash: shot.hash });
        }).catch(function () {
          resolve({ ready: true, live: null, hash: null });
        });
      }
      poll();
    });
  }

  function hashCanvas(canvas, ctx) {
    // Downscale to 32x18 and hash the pixels: a cheap perceptual hash that
    // changes whenever the screen changes.
    var small = document.createElement("canvas");
    small.width = 32;
    small.height = 18;
    var sctx = small.getContext("2d");
    sctx.drawImage(canvas, 0, 0, 32, 18);
    var data = sctx.getImageData(0, 0, 32, 18).data;
    var str = "";
    for (var i = 0; i < data.length; i += 16) {
      str += String.fromCharCode(data[i] >> 4, data[i + 1] >> 4, data[i + 2] >> 4);
    }
    return fnv1a(str);
  }

  // ------------------------------------------------------------ state

  function observe() {
    var canvas = getCanvas();
    var shell = global.RottStatus && typeof global.RottStatus === "object" ? global.RottStatus : {};
    // Contract section 2: window.ROTT.getStatus() is the page's own status
    // line (engine stdout/stderr, last 5 lines, via window.__rottLog).
    var rottStatus = null;
    try {
      if (global.ROTT && typeof global.ROTT.getStatus === "function") rottStatus = global.ROTT.getStatus();
    } catch (e) { rottStatus = null; }
    var state = {
      status: rottStatus || shell.status || status,
      bridgeConnected: true,
      episode: typeof shell.episode === "number" ? shell.episode : null,
      level: typeof shell.level === "number" ? shell.level : null,
      levelName: typeof shell.levelName === "string" ? shell.levelName : null,
      difficulty: typeof shell.difficulty === "string" ? shell.difficulty : null,
      health: typeof shell.health === "number" ? shell.health : null,
      armor: typeof shell.armor === "number" ? shell.armor : null,
      ammo: shell.ammo || null,
      weapons: shell.weapons || null,
      score: typeof shell.score === "number" ? shell.score : null,
      lives: typeof shell.lives === "number" ? shell.lives : null,
      screenHash: lastScreenHash,
      screenCapturedAt: lastScreenHash ? nowIso() : null,
      hudText: typeof shell.hudText === "string" ? shell.hudText : null,
      saveSlots: saveSlotsCache,
      updatedAt: nowIso(),
    };
    if (canvas) {
      state.canvasWidth = canvas.width;
      state.canvasHeight = canvas.height;
    }
    return Promise.resolve(state);
  }

  // ------------------------------------------------------------ saves

  function listSaveFiles() {
    var FS = getFS();
    var slots = [];
    for (var i = 0; i < NUM_SAVE_SLOTS; i++) {
      slots.push({ slot: i, label: null, levelName: null, savedAt: null, exists: false });
    }
    if (!FS) return slots;
    // Engine save files are rottgam<hex>.rot (rt_menu.c: SaveName =
    // "rottgam?.rot"; the slot digit is itoa(slot, 16), so slots 10-13
    // are a-d). The contract's "SAVEGAM?.ROT" does not exist in the
    // engine. rottgamf.rot (slot 0xf) is the quicksave backup, not a
    // menu slot, so it is reported separately and never listed as a slot.
    var saveDir = resolveSaveDir();
    try {
      var names = FS.readdir(saveDir);
      names.forEach(function (name) {
        var m = /^rottgam([0-9a-f])\.rot$/i.exec(name);
        if (!m) return;
        var slot = parseInt(m[1], 16);
        if (slot < 0 || slot >= NUM_SAVE_SLOTS) return;
        var stat = null;
        try { stat = FS.stat(saveDir + "/" + name); } catch (e) { /* ignore */ }
        slots[slot] = {
          slot: slot,
          label: name,
          levelName: null,
          savedAt: stat && stat.mtime ? new Date(stat.mtime).toISOString() : null,
          exists: true,
        };
      });
    } catch (e) {
      // Save dir may not exist yet (no saves). That is fine.
    }
    saveSlotsCache = slots;
    return slots;
  }

  // Menu hotkey for a save/load slot: the load/save screen lists 14 slots
  // with hotkeys 'a'..'n' (rt_menu.c LSMenu). Slots are cursor positions,
  // not digit keys — typing a digit would land in the name prompt.
  function slotHotkey(slot) {
    return String.fromCharCode("a".charCodeAt(0) + slot);
  }

  function saveGame(slot, label) {
    // Drive the game's own save menu, exactly as a human player would:
    // Esc -> main menu -> 's' (SAVE GAME hotkey) -> slot hotkey
    // ('a'+slot) -> Enter if the slot is occupied (overwrite prompt,
    // Yes is the default) -> name prompt (clear the pre-filled name,
    // type the label, Enter). The old F2/digit/Enter sequence was wrong:
    // F2 is a RemoteRidicule taunt in-game, and slots are cursor
    // positions selected by hotkey, not digit keys. Requires an in-game
    // session: SAVE GAME is inactive on the title menu. After the save,
    // trigger an IDBFS sync (contract section 3) so the save reaches
    // IndexedDB now instead of at the next 30 s tick.
    slot = Math.max(0, Math.min(NUM_SAVE_SLOTS - 1, typeof slot === "number" ? slot : 0));
    status = "loading";
    listSaveFiles();
    var occupied = !!(saveSlotsCache[slot] && saveSlotsCache[slot].exists);
    var name = typeof label === "string" && label ? label : ("Save " + (slot + 1));
    return sendKey({ key: options.keys.menu, action: "press" })
      .then(function () { return sleep(400); })
      .then(function () { return sendKey({ key: "s", action: "press" }); })
      .then(function () { return sleep(400); })
      .then(function () { return sendKey({ key: slotHotkey(slot), action: "press" }); })
      .then(function () { return sleep(400); })
      .then(function () {
        if (!occupied) return Promise.resolve();
        return sendKey({ key: options.keys.confirm, action: "press" })
          .then(function () { return sleep(300); });
      })
      .then(function () {
        // The name prompt is pre-filled with the old name; clear it first.
        var chain = Promise.resolve();
        for (var i = 0; i < 31; i++) {
          chain = chain.then(function () { return sendKey({ key: "Backspace", action: "press", holdMs: 20 }); });
        }
        return chain;
      })
      .then(function () { return sendText(name); })
      .then(function () { return sendKey({ key: options.keys.confirm, action: "press" }); })
      .then(function () { return sleep(500); })
      .then(function () { return syncFiles(); })
      .then(function () {
        status = "playing";
        listSaveFiles();
        var saved = saveSlotsCache[slot] || { slot: slot, exists: true };
        saved.label = name;
        saved.savedAt = nowIso();
        saved.exists = true;
        saveSlotsCache[slot] = saved;
        pushEvent("game.saved", { slot: slot, label: saved.label });
        return { slot: saved };
      });
  }

  function loadGame(slot) {
    // The engine has no quickload key: loading is menu-only. Esc -> main
    // menu -> 'r' (RESTORE GAME hotkey) -> slot hotkey ('a'+slot) loads
    // directly (CP_LoadGame -> DoLoad, no confirm). Requires an in-game
    // session; RESTORE GAME is inactive on the title menu.
    slot = Math.max(0, Math.min(NUM_SAVE_SLOTS - 1, typeof slot === "number" ? slot : 0));
    status = "loading";
    return sendKey({ key: options.keys.menu, action: "press" })
      .then(function () { return sleep(400); })
      .then(function () { return sendKey({ key: "r", action: "press" }); })
      .then(function () { return sleep(400); })
      .then(function () { return sendKey({ key: slotHotkey(slot), action: "press" }); })
      .then(function () { return sleep(600); })
      .then(function () {
        status = "playing";
        pushEvent("game.loaded", { slot: slot });
        return observe();
      });
  }

  // ------------------------------------------------------------ config

  function applyConfig(config) {
    // Best-effort. Resolution/fullscreen only take effect on module (re)load.
    // The engine's own config.rot is engine-native binary (rt_cfg.c) and
    // is NEVER written by the bridge: the old code wrote JSON into
    // CONFIG.ROT, which on a case-sensitive FS is a different file from
    // config.rot and would corrupt the engine's config if it ever landed
    // there. Bridge-side config goes to the bridge's own rott-bridge.json
    // (options.configFile) instead; engine config stays server-side only.
    var pendingReload = [];
    var FS = getFS();
    if (FS && config.video && (config.video.resolution || config.video.fullscreen !== undefined)) {
      pendingReload.push("video");
    }
    if (FS) {
      try {
        var text = JSON.stringify({ rottBridgeConfig: config, updatedAt: nowIso() }, null, 2);
        FS.writeFile(options.configFile, text);
      } catch (e) {
        log("config file write failed (continuing without it):", e && e.message);
      }
    } else {
      log("config.apply: no FS exposed; config held server-side only.");
    }
    return Promise.resolve({ applied: config, pendingReload: pendingReload });
  }

  // ------------------------------------------------------------ mods

  function applyMod(mod) {
    // Data-driven only: write WAD overlays into the game's data dir via
    // the FS when exposed, and hand the JSON overrides to the script layer
    // (a generated "mod:<id>" script that exposes the values to scripts).
    var FS = getFS();
    var overlays = mod.wadOverlays || [];
    var overlayFiles = mod.overlayFiles || []; // [{name, base64}]
    if (FS) {
      overlayFiles.forEach(function (file) {
        try {
          var binary = atob(file.base64);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          FS.writeFile(options.dataDir + "/" + file.name, bytes);
        } catch (e) {
          log("mod overlay write failed for", file.name, e && e.message);
        }
      });
    } else if (overlayFiles.length > 0) {
      log("mod.apply: no FS exposed; WAD overlays cannot be installed without it.");
    }
    var overrides = { weapons: mod.weapons || {}, enemies: mod.enemies || {}, levels: mod.levels || {} };
    global.RottModValues = global.RottModValues || {};
    global.RottModValues[mod.id] = overrides;
    pushEvent("mod.loaded", { id: mod.id, overlaysInstalled: overlayFiles.length, fsAvailable: !!FS });
    return Promise.resolve({
      id: mod.id,
      overlaysInstalled: overlayFiles.length,
      fsAvailable: !!FS,
      note: overlays.length > 0 && !FS
        ? "WAD overlays need the FS (Emscripten Module.FS) to install; JSON overrides are live in window.RottModValues."
        : "JSON overrides live in window.RottModValues; WAD overlays apply on next level load.",
    });
  }

  function removeMod(id) {
    if (global.RottModValues) delete global.RottModValues[id];
    pushEvent("mod.unloaded", { id: id });
    return Promise.resolve({ id: id, removed: true });
  }

  // ------------------------------------------------------------ scripts

  function registerScript(name, code) {
    var fn = null;
    var error = null;
    try {
      // Evaluated in the page context, outside the WASM module. The
      // script gets {bridge, log, modValues} and may return {onTick,
      // onEvent, onLoad}. It can only drive the game via bridge input.
      var factory = new Function("ctx", code + "\n;return (typeof RottScript !== 'undefined' ? RottScript : null);");
      var api = makeScriptApi();
      var hooks = factory({ bridge: api, log: log, modValues: global.RottModValues || {} });
      fn = hooks && typeof hooks === "object" ? hooks : {};
      if (fn.onLoad) fn.onLoad(api);
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
    if (error) throw new Error("Script '" + name + "' failed to evaluate: " + error);
    scripts[name] = { code: code, hooks: fn, enabled: true, updatedAt: nowIso() };
    ensureScriptLoop();
    return Promise.resolve({ name: name, registered: true });
  }

  function makeScriptApi() {
    return {
      key: function (key, holdMs) { return sendKey({ key: key, action: "press", holdMs: holdMs || 50 }); },
      mouse: function (x, y, action) { return sendMouse({ x: x, y: y, action: action || "click", button: "left" }); },
      text: function (text) { return sendText(text); },
      observe: observe,
      capture: captureScreen,
      save: function (slot) { return saveGame(slot); },
      load: function (slot) { return loadGame(slot); },
    };
  }

  function ensureScriptLoop() {
    if (scriptTimer !== null) return;
    scriptTimer = setInterval(function () {
      var names = Object.keys(scripts);
      if (names.length === 0) return;
      observe().then(function (state) {
        names.forEach(function (name) {
          var entry = scripts[name];
          if (!entry || !entry.enabled || !entry.hooks || typeof entry.hooks.onTick !== "function") return;
          try {
            entry.hooks.onTick(state, makeScriptApi());
          } catch (e) {
            log("script '" + name + "' onTick error:", e && e.message);
          }
        });
      }).catch(function () { /* observe is best-effort */ });
    }, 500);
  }

  function unregisterScript(name) {
    delete scripts[name];
    return Promise.resolve({ name: name, removed: true });
  }

  function reloadScript(name) {
    var entry = scripts[name];
    if (!entry) throw new Error("Unknown script: " + name);
    delete scripts[name];
    return registerScript(name, entry.code);
  }

  // ------------------------------------------------------------ game lifecycle

  function gameInfo() {
    var canvas = getCanvas();
    var FS = getFS();
    var dataSet = "unknown";
    if (FS) {
      try {
        var names = FS.readdir(options.dataDir);
        if (names.indexOf("DARKWAR.WAD") !== -1 || names.indexOf("DARKWAR.RTC") !== -1) dataSet = "registered";
        else if (names.indexOf("HUNTBGIN.WAD") !== -1 || names.indexOf("HUNTBGIN.RTC") !== -1) dataSet = "shareware";
      } catch (e) { /* ignore */ }
    }
    return Promise.resolve({
      version: null,
      dataSet: dataSet,
      bridgeVersion: VERSION,
      wasmModuleUrl: currentWasmUrl(),
      canvasWidth: canvas ? canvas.width : null,
      canvasHeight: canvas ? canvas.height : null,
      fsAvailable: !!FS,
      saveDir: resolveSaveDir(),
    });
  }

  function currentWasmUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get("wasm");
    } catch (e) {
      return null;
    }
  }

  function newGame(episode, level, difficulty) {
    status = "loading";
    return runMenuSequence("newGame").then(function () {
      status = "playing";
      pushEvent("game.new", { episode: episode, level: level, difficulty: difficulty });
      return observe();
    });
  }

  function pauseGame() {
    return sendKey({ key: options.keys.pause, action: "press" }).then(function () {
      status = "paused";
      return observe();
    });
  }

  function resumeGame() {
    return sendKey({ key: options.keys.pause, action: "press" }).then(function () {
      status = "playing";
      return observe();
    });
  }

  function quitGame() {
    return runMenuSequence("quitToMenu").then(function () {
      status = "menu";
      pushEvent("game.quit", {});
      return observe();
    });
  }

  function playDemo(demo, loop) {
    // Demos play from the game's own demo playback: open the menu and
    // select the demo. The exact menu path is a lane-1 integration point;
    // this implementation sends the demo name as text after opening the
    // menu, which the stock menus accept on the demo entry.
    status = "demo";
    return sendKey({ key: options.keys.menu, action: "press" })
      .then(function () { return sleep(300); })
      .then(function () { return sendText(demo); })
      .then(function () { return sleep(300); })
      .then(function () { return sendKey({ key: options.keys.confirm, action: "press" }); })
      .then(function () {
        pushEvent("demo.started", { demo: demo, loop: !!loop });
        return observe();
      });
  }

  function stopDemo() {
    return sendKey({ key: options.keys.menu, action: "press" }).then(function () {
      status = "menu";
      pushEvent("demo.stopped", {});
      return observe();
    });
  }

  function multiplayerHost(req) {
    return runMenuSequence("hostGame").then(function () {
      pushEvent("multiplayer.hosted", req);
      return observe();
    });
  }

  function multiplayerJoin(address, playerName) {
    return runMenuSequence("joinGame")
      .then(function () { return sendText(address); })
      .then(function () { return sendKey({ key: options.keys.confirm, action: "press" }); })
      .then(function () {
        pushEvent("multiplayer.joined", { address: address, playerName: playerName || null });
        return observe();
      });
  }

  function multiplayerLeave() {
    return runMenuSequence("leaveGame").then(function () {
      pushEvent("multiplayer.left", {});
      return observe();
    });
  }

  function chatType(text) {
    return sendKey({ key: options.keys.chat, action: "press" })
      .then(function () { return sleep(200); })
      .then(function () { return sendText(text); })
      .then(function () { return sendKey({ key: options.keys.confirm, action: "press" }); })
      .then(function () { return { accepted: true }; });
  }

  // ------------------------------------------------------------ wasm swap

  function swapWasm(moduleUrl, saveSlot) {
    // Save state through the game's own save, then reload the page with
    // the new module URL. On boot the bridge re-loads the save (?load=).
    // The page reload is the honest mechanism: no restart of the game
    // from scratch, but the page itself does reload.
    return saveGame(saveSlot, "wasm-swap").then(function () {
      try {
        sessionStorage.setItem("rott.swap", JSON.stringify({ moduleUrl: moduleUrl, saveSlot: saveSlot }));
      } catch (e) { /* sessionStorage may be unavailable */ }
      var url = new URL(window.location.href);
      url.searchParams.set("wasm", moduleUrl);
      url.searchParams.set("load", String(saveSlot));
      pushEvent("wasm.swap", { moduleUrl: moduleUrl, saveSlot: saveSlot });
      window.location.href = url.toString();
      return { accepted: true, saveSlot: saveSlot, moduleUrl: moduleUrl };
    });
  }

  // ------------------------------------------------------------ sidecar link

  function send(obj) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
  }

  function pushEvent(event, payload) {
    send({ type: "event", event: event, payload: payload || {} });
  }

  function handleRequest(req) {
    var id = req.id;
    var method = req.method;
    var params = req.params || {};
    var work;
    try {
      work = dispatch(method, params);
    } catch (e) {
      work = Promise.reject(e);
    }
    work.then(
      function (result) { send({ id: id, ok: true, result: result }); },
      function (err) { send({ id: id, ok: false, error: err && err.message ? err.message : String(err) }); },
    );
  }

  function dispatch(method, params) {
    switch (method) {
      case "input.key": return sendKey(params.input || {});
      case "input.mouse": return sendMouse(params.input || {});
      case "input.text": return sendText(params.text || "");
      case "input.sequence": return runSequence(params.events || []);
      case "state.observe": return observe();
      case "screen.capture": return captureScreen();
      case "config.apply": return applyConfig(params.config || {});
      case "config.read": return observe().then(function () { return { config: null, note: "Config is held server-side; the bridge reports observations only." }; });
      case "save.quick": return saveGame(params.slot, params.label);
      case "save.load": return loadGame(params.slot);
      case "save.list": return Promise.resolve({ slots: listSaveFiles() });
      case "save.sync": return syncFiles();
      case "game.wait": return waitForGame(typeof params.timeoutMs === "number" ? params.timeoutMs : 10000);
      case "demo.play": return playDemo(params.demo, params.loop);
      case "demo.stop": return stopDemo();
      case "mod.apply": return applyMod(params.mod || {});
      case "mod.remove": return removeMod(params.id);
      case "script.register": return registerScript(params.name, params.code || "");
      case "script.unregister": return unregisterScript(params.name);
      case "script.reload": return reloadScript(params.name);
      case "wasm.swap": return swapWasm(params.moduleUrl, typeof params.saveSlot === "number" ? params.saveSlot : 9);
      case "game.new": return newGame(params.episode || 1, params.level || 1, params.difficulty || "normal");
      case "game.pause": return pauseGame();
      case "game.resume": return resumeGame();
      case "game.quit": return quitGame();
      case "game.info": return gameInfo();
      case "multiplayer.host": return multiplayerHost(params);
      case "multiplayer.join": return multiplayerJoin(params.address, params.playerName);
      case "multiplayer.leave": return multiplayerLeave();
      case "chat.type": return chatType(params.text || "");
      default: return Promise.reject(new Error("Unknown bridge method: " + method));
    }
  }

  function connect() {
    if (typeof WebSocket === "undefined") {
      log("No WebSocket in this page; bridge cannot connect to the sidecar.");
      return;
    }
    try {
      socket = new WebSocket(options.sidecarUrl);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    socket.onopen = function () {
      log("connected to sidecar", options.sidecarUrl);
      var canvas = getCanvas();
      send({
        type: "event",
        event: "bridge.hello",
        payload: {
          bridgeVersion: VERSION,
          canvasWidth: canvas ? canvas.width : null,
          canvasHeight: canvas ? canvas.height : null,
          wasmModuleUrl: currentWasmUrl(),
          pageUrl: window.location.href,
        },
      });
      // After a WASM swap the page boots with ?load=<slot>: re-load the save.
      try {
        var params = new URLSearchParams(window.location.search);
        var load = params.get("load");
        if (load !== null) {
          var slot = parseInt(load, 10);
          if (!isNaN(slot)) {
            setTimeout(function () {
              loadGame(slot).catch(function (e) { log("post-swap load failed:", e && e.message); });
            }, 1500);
          }
        }
      } catch (e) { /* ignore */ }
      listSaveFiles();
    };
    socket.onmessage = function (ev) {
      var req = null;
      try { req = JSON.parse(ev.data); } catch (e) { return; }
      if (req && typeof req.id === "number" && typeof req.method === "string") handleRequest(req);
    };
    socket.onclose = function () {
      log("sidecar disconnected; reconnecting in", options.reconnectMs, "ms");
      socket = null;
      scheduleReconnect();
    };
    socket.onerror = function () {
      try { socket.close(); } catch (e) { /* ignore */ }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, options.reconnectMs);
  }

  // ------------------------------------------------------------ public API

  var api = {
    version: VERSION,
    configure: function (opts) {
      options = Object.assign(defaults(), options, opts || {});
      return api;
    },
    connect: connect,
    key: function (key, holdMs) { return sendKey({ key: key, action: "press", holdMs: holdMs || 50 }); },
    mouse: function (x, y, action) { return sendMouse({ x: x, y: y, action: action || "click", button: "left" }); },
    text: function (text) { return sendText(text); },
    observe: observe,
    capture: captureScreen,
    save: saveGame,
    load: loadGame,
    sync: syncFiles,
    waitForGame: waitForGame,
    status: function () { return status; },
    scripts: function () { return Object.keys(scripts); },
  };

  global.RottBridge = api;

  // Auto-connect unless the page opts out (?bridge=off or RottBridgeAuto=false).
  var auto = true;
  try {
    if (new URLSearchParams(window.location.search).get("bridge") === "off") auto = false;
    if (global.RottBridgeAuto === false) auto = false;
  } catch (e) { /* ignore */ }
  if (auto) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", connect);
    } else {
      connect();
    }
  }
})(typeof window !== "undefined" ? window : this);
