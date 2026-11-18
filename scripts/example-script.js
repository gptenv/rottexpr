// SPDX-License-Identifier: MIT
// Example hot-reloadable script-layer program for the ROTT sidecar.
//
// What this is: a plain JS file that runs in the page's JS context,
// OUTSIDE the WASM module. The bridge (`bridge/rott-bridge.js`) evaluates
// it with `new Function("ctx", code + ";return RottScript")`, passing
// `ctx = { bridge, log, modValues }`, and then calls the hooks it returns:
// `onLoad(api)` once at registration and `onTick(state, api)` every
// 500 ms. The game is never restarted by the script layer.
//
// What this example does: a gentle "patrol" autopilot. While the game
// reports `status === "playing"` it walks forward in short bursts and
// turns left/right on alternate moves, and it logs whenever the screen
// hash or the visible score/health changes. It never fires, never opens
// menus, never saves or loads, and never touches engine internals — it
// only drives the game through the bridge API, exactly as a human player
// would (synthetic key presses into the canvas).
//
// How to load it: POST the file contents as the `code` of a Script to the
// sidecar (see scripts/README.md). The registered name is
// `example-script`. Editing this file and re-registering it (or calling
// the reload endpoint after re-registering) hot-reloads it in place.
//
// NOTE on hooks: the OpenAPI `Script` schema also names an `onEvent`
// hook, but bridge v1.0.0 only ever calls `onLoad` and `onTick` —
// `onEvent` is never invoked. This example therefore does not define
// `onEvent`; it learns about the game only by polling `state` in
// `onTick`. See scripts/README.md ("Limits") for the full list.

// `ctx` is the bridge's registration context ({ bridge, log, modValues }).
// When this file is evaluated any other way (a plain <script> tag, a Node
// syntax check), `ctx` is undefined, so fall back to console logging and
// empty mod values instead of throwing at load time.
var __ctx = (typeof ctx !== "undefined" && ctx) || {};
var __log = (typeof __ctx.log === "function")
  ? __ctx.log
  : (typeof console !== "undefined" && typeof console.log === "function"
    ? function () { console.log.apply(console, ["[example-script]"].concat(Array.prototype.slice.call(arguments))); }
    : function () {});
var __modValues = __ctx.modValues || {};

// --- state kept between ticks (all plain values, no engine access) ---
var tickCount = 0;
var lastScreenHash = null;
var lastHealth = null;
var lastScore = null;
var turnLeftNext = true;

function noteModValues() {
  // The `double-damage` example mod (mods/example-mod) exposes its JSON
  // overrides in window.RottModValues, which the bridge passes in as
  // ctx.modValues. Reading them is optional: this script works the same
  // with or without any mod loaded.
  var dd = __modValues["double-damage"];
  if (dd && dd.weapons && dd.weapons.Pistol && typeof dd.weapons.Pistol.damage === "number") {
    __log("double-damage mod active: pistol damage is", dd.weapons.Pistol.damage);
  }
}

var RottScript = {
  // Called once, at registration, with the bridge API
  // ({ key, mouse, text, observe, capture, save, load }).
  // Keep it side-effect free apart from logging: registration must never
  // fail because of a game action.
  onLoad: function (api) {
    __log("example-script loaded: patrol autopilot (walk + turn, no firing).");
    noteModValues();
  },

  // Called every 500 ms with the observed state (see bridge `observe()`:
  // status, health, armor, ammo, score, lives, screenHash, ...). Any of
  // the numeric/HUD fields may be null — the page shell only fills them
  // in when it can read them off the screen, so never assume a value.
  onTick: function (state, api) {
    // Only act while actually playing. In menus, on the title screen, or
    // while loading, do nothing — pressing keys there would drive menus.
    // The tick counter only advances while playing, so the patrol cadence
    // is measured in playing time, not wall-clock time.
    if (!state || state.status !== "playing") {
      return;
    }
    tickCount++;

    // Log visible changes. screenHash changes whenever the rendered frame
    // changes; health/score are null unless the page shell exposes them,
    // so a change from null to a number (or back) is reported once.
    if (state.screenHash !== lastScreenHash) {
      lastScreenHash = state.screenHash;
      __log("screen changed (hash " + state.screenHash + ").");
    }
    if (state.health !== lastHealth) {
      lastHealth = state.health;
      if (state.health !== null && state.health !== undefined) {
        __log("health is now " + state.health + ".");
      }
    }
    if (state.score !== lastScore) {
      lastScore = state.score;
      if (state.score !== null && state.score !== undefined) {
        __log("score is now " + state.score + ".");
      }
    }

    // Patrol: act at most once every 4 playing ticks (~2 s). A single key
    // press takes ~50 ms of hold by default, so a 2 s cadence can never
    // overlap the previous press. Alternate a forward walk with a turn so
    // the player wanders instead of walking into a wall forever; the first
    // action is a walk, the second a turn, and so on.
    if (tickCount % 4 !== 0) {
      return;
    }
    var actionIndex = tickCount / 4 - 1;
    if (actionIndex % 2 === 0) {
      // Walk forward for ~800 ms.
      api.key("ArrowUp", 800);
    } else {
      // Turn left and right on alternate moves.
      var dir = turnLeftNext ? "ArrowLeft" : "ArrowRight";
      turnLeftNext = !turnLeftNext;
      api.key(dir, 300);
    }
  }
};
