// SPDX-License-Identifier: MIT
// ROTT WASM demo page logic (MIT). Loads the generated Emscripten module
// (build/wasm/rott.js) only after a user gesture, so SDL_mixer audio can
// start under browser autoplay policy. This file is the page shell only:
// it does NOT implement the agent bridge — it exposes the minimal DOM hooks
// lane 2's bridge builds on (see BRIDGE-CONTRACT.md).
//
// The module itself is the GPL engine, compiled. Nothing here links into
// it, modifies it, or reads its memory. All interaction is through the
// DOM: the canvas element, synthetic input events, and screenshots.
(function () {
  "use strict";

  var canvas = document.getElementById("rott-canvas");
  var statusEl = document.getElementById("rott-status");
  var overlay = document.getElementById("start-overlay");
  var startBtn = document.getElementById("start-btn");
  var started = false;
  var statusLines = [];

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // Emscripten pre-js forwards engine stdout/stderr here (web/rott-pre.js).
  window.__rottLog = function (text, stream) {
    statusLines.push("[" + (stream || "log") + "] " + text);
    if (statusLines.length > 5) statusLines = statusLines.slice(-5);
    setStatus(statusLines.join("\n"));
  };

  window.addEventListener("error", function (ev) {
    setStatus("Error: " + (ev.message || ev.error || "unknown error"));
  });

  // Resolve where rott.js lives. Two supported layouts:
  //   repo-root serving (make -f Makefile.emcc run): page at /web/index.html,
  //     module at /build/wasm/rott.js  -> "../build/wasm/rott.js"
  //   flat deploy (Pages: web/ + build outputs copied into one dir):
  //     page at /index.html, module at /rott.js -> "rott.js"
  // Derived from this script's own URL so both layouts work unchanged.
  function moduleCandidates() {
    var scriptUrl = null;
    try {
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].src && /\/app\.js(\?|#|$)/.test(scripts[i].src)) {
          scriptUrl = scripts[i].src;
          break;
        }
      }
    } catch (e) { /* fall through to location-based guess */ }
    var base;
    try {
      base = new URL(scriptUrl || window.location.href);
    } catch (e) {
      base = new URL(window.location.href);
    }
    var dir = base.href.replace(/\/[^/]*$/, "/");
    return [
      new URL("../build/wasm/rott.js", dir).href,
      new URL("rott.js", dir).href,
    ];
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(src); };
      s.onerror = function () { reject(new Error("failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  function loadModuleSequentially(candidates) {
    var chain = Promise.reject(new Error("no candidates tried"));
    candidates.forEach(function (src) {
      chain = chain.catch(function () { return loadScript(src); });
    });
    return chain;
  }

  function startGame() {
    if (started) return;
    started = true;
    if (overlay) overlay.hidden = true;
    setStatus("Starting… unlocking audio, loading rott.js…");

    // Unlock WebAudio: SDL_mixer needs a resumed AudioContext, which
    // browsers only allow after a user gesture (this click).
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        var ctx = new AC();
        if (ctx.resume) ctx.resume().catch(function () { /* ignore */ });
        window.__rottAudioContext = ctx;
      }
    } catch (e) { /* audio unlock is best-effort */ }

    loadModuleSequentially(moduleCandidates()).then(function (src) {
      setStatus("Loaded " + src + " — game starting…");
      if (canvas) canvas.focus();
    }).catch(function (err) {
      setStatus(
        "Could not load rott.js (" + err.message + "). " +
        "Build it first: make -f Makefile.emcc, then serve the repo root " +
        "(make -f Makefile.emcc run) and open /web/index.html."
      );
      started = false;
      if (overlay) overlay.hidden = false;
    });
  }

  if (startBtn) startBtn.addEventListener("click", startGame);

  // Clicking the canvas focuses it so keyboard input goes to the game.
  // Emscripten's SDL layer requests pointer lock on canvas click when the
  // game uses relative mouse mode; Esc releases it (browser behaviour).
  if (canvas) {
    canvas.addEventListener("click", function () { canvas.focus(); });
    canvas.addEventListener("keydown", function (ev) {
      // Keep game keys (arrows, space) from scrolling the page.
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].indexOf(ev.key) !== -1) {
        ev.preventDefault();
      }
    });
  }

  // ---- Minimal DOM hooks for lane 2's bridge (see BRIDGE-CONTRACT.md) ----
  // These are the ONLY page-side entry points the bridge uses. They do what
  // a human player does (dispatch input events, read pixels) and nothing
  // that touches engine internals.
  window.ROTT = {
    canvas: canvas,

    getStatus: function () {
      return statusEl ? statusEl.textContent : "";
    },

    // Screenshot of the canvas. LIMITATION, stated honestly: Emscripten
    // creates the WebGL context with preserveDrawingBuffer=false, so
    // toDataURL() returns a blank frame unless called in the same frame
    // the game just rendered. Lane 2 must call this from inside a
    // requestAnimationFrame callback (or use canvas.captureStream), not
    // from a timer. See BRIDGE-CONTRACT.md.
    screenshot: function () {
      if (!canvas) return null;
      try { return canvas.toDataURL("image/png"); }
      catch (e) { return null; }
    },

    // Synthetic keyboard input, exactly as a human keypress arrives.
    // `code` is the physical key (e.g. "ArrowUp", "ControlLeft", "Space");
    // `key` is the character/key value (e.g. "ArrowUp", " ", "a").
    dispatchKey: function (type, code, key) {
      if (!canvas) return false;
      var ev = new KeyboardEvent(type, {
        code: code, key: key || code,
        bubbles: true, cancelable: true, composed: true,
      });
      return canvas.dispatchEvent(ev);
    },

    // Synthetic mouse input. `opts`: {button, clientX, clientY, movementX,
    // movementY, buttons}. Pointer-lock movement deltas arrive as
    // movementX/movementY on mousemove events.
    dispatchMouse: function (type, opts) {
      if (!canvas) return false;
      opts = opts || {};
      var rect = canvas.getBoundingClientRect();
      var ev = new MouseEvent(type, {
        button: opts.button || 0,
        buttons: opts.buttons !== undefined ? opts.buttons : (type === "mousedown" ? 1 : 0),
        clientX: opts.clientX !== undefined ? opts.clientX : rect.left + rect.width / 2,
        clientY: opts.clientY !== undefined ? opts.clientY : rect.top + rect.height / 2,
        bubbles: true, cancelable: true, composed: true,
      });
      // movementX/Y are read-only on MouseEvent init in some browsers;
      // define them when the caller supplies them.
      if (opts.movementX !== undefined || opts.movementY !== undefined) {
        try {
          Object.defineProperties(ev, {
            movementX: { value: opts.movementX || 0 },
            movementY: { value: opts.movementY || 0 },
          });
        } catch (e) { /* non-critical */ }
      }
      return canvas.dispatchEvent(ev);
    },

    focusCanvas: function () {
      if (canvas) canvas.focus();
      return !!canvas;
    },
  };
})();
