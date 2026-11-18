// SPDX-License-Identifier: MIT
// Emscripten --pre-js for the ROTT WASM build (MIT).
//
// Runs inside the generated rott.js before main(). Its only jobs:
//   1. point the module at the page canvas (#rott-canvas),
//   2. mount IDBFS at the engine's save dir and populate it from IndexedDB
//      BEFORE main() runs, so CONFIG.ROT and save games are visible on boot,
//   3. keep IDBFS synced back to IndexedDB while the game runs.
//
// Verified engine fact (src/dosutil.c setup_homedir): the engine writes
// config/saves under $HOME/.rott/ for the shareware build and
// $HOME/.rott/darkwar/ for the registered build. In Emscripten HOME is
// /home/web_user, so the shareware save dir is /home/web_user/.rott/.
// The registered path is kept here as a constant for a registered build;
// this file never touches registered game data itself.
//
// If IDBFS fails for any reason, the game degrades to MEMFS-only (saves
// lost on reload) instead of crashing: every step is wrapped in try/catch
// and a failed initial sync still releases the run dependency.

// Shareware save dir. A registered build overrides this via --pre-js with
// SAVE_DIR set to "/home/web_user/.rott/darkwar" (see Makefile.emcc).
var ROTT_SAVE_DIR = "/home/web_user/.rott";

var Module = typeof Module !== "undefined" ? Module : {};

Module.canvas = (function () {
  var c = document.getElementById("rott-canvas");
  return c || undefined;
})();

// Forward engine stdout/stderr to the page status hook when present.
Module.print = function (text) {
  if (typeof window !== "undefined" && typeof window.__rottLog === "function") {
    window.__rottLog(text, "stdout");
  } else if (typeof console !== "undefined") {
    console.log(text);
  }
};
Module.printErr = function (text) {
  if (typeof window !== "undefined" && typeof window.__rottLog === "function") {
    window.__rottLog(text, "stderr");
  } else if (typeof console !== "undefined") {
    console.warn(text);
  }
};

Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  try {
    // /home/web_user is created by the Emscripten runtime; tolerate it
    // already existing or the save dir already existing.
    try { FS.mkdir(ROTT_SAVE_DIR); } catch (e) { /* EEXIST is fine */ }
    FS.mount(IDBFS, {}, ROTT_SAVE_DIR);
  } catch (e) {
    Module.printErr("ROTT pre-js: IDBFS mount failed, saves will be MEMFS-only: " + e);
    return; // do not block main() on a broken mount
  }
  // Block main() until the initial IndexedDB -> MEMFS sync completes.
  // addRunDependency/removeRunDependency are Emscripten runtime helpers
  // available inside preRun.
  try {
    addRunDependency("rott-idbfs-sync");
    FS.syncfs(true, function (err) {
      if (err) {
        Module.printErr("ROTT pre-js: initial IDBFS sync failed: " + err);
      }
      removeRunDependency("rott-idbfs-sync");
    });
  } catch (e) {
    Module.printErr("ROTT pre-js: initial IDBFS sync setup failed: " + e);
    try { removeRunDependency("rott-idbfs-sync"); } catch (ignored) {}
  }
});

Module.postRun = Module.postRun || [];
Module.postRun.push(function () {
  // Periodic persist: MEMFS -> IndexedDB every 30 s.
  function persist() {
    try {
      FS.syncfs(false, function (err) {
        if (err) Module.printErr("ROTT: IDBFS persist failed: " + err);
      });
    } catch (e) {
      Module.printErr("ROTT: IDBFS persist threw: " + e);
    }
  }
  try { setInterval(persist, 30000); } catch (e) { /* timers unavailable */ }
  // Final persist when the page is hidden or unloaded.
  function persistNow() { persist(); }
  try {
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) persistNow();
    });
    window.addEventListener("pagehide", persistNow);
  } catch (e) { /* event hooks unavailable */ }
});
