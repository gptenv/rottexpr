// SPDX-License-Identifier: MIT
/**
 * ROTT toggleable agent panel for the WASM game page (Phase 7, lane L50).
 *
 * WIRING (one line — this file does NOT edit web/index.html, which is
 * lane L03's file): add this tag to web/index.html, after app.js:
 *
 *   <script src="ui-panel.js" defer></script>
 *
 * On load the script builds its own toggle button ("Agents") and panel
 * DOM and appends them to the page, so no other index.html change is
 * needed. The panel starts hidden; the button (and the `p` keyboard
 * shortcut, when the game canvas is not focused) toggles it.
 *
 * What it does — the same launcher + chat-steering UI as ui/app.js,
 * embedded in the game page instead of living on a separate page:
 *   - Agent registry: custom / local agents only, no built-in list.
 *     Same storage key as ui/app.js (`rott.agents.v1`); credentials are
 *     session-only unless "remember" is ticked.
 *   - Connection setup: sidecar REST base URL + WebSocket URL, same
 *     defaults as ui/app.js (http://localhost:8787, ws://localhost:8787/ws)
 *     and same settings key (`rott.ui.settings.v1`).
 *   - Launch controls: mode (comm-bat / cooperative / score-attack),
 *     episode, level, difficulty, max players, join address; host / join /
 *     leave / pause / resume / quit.
 *   - Live chat steering: send messages to a playing agent and read its
 *     replies while it plays.
 *   - Spectator view: live state readout + screen image from the sidecar.
 *
 * It talks to the game ONLY through the sidecar's published interfaces —
 * the same functions as ui/app.js (`connect`, `disconnect`, `launch`,
 * `sendChatMessage`, `refreshState`, `refreshScreen`, `refreshChat`) and
 * the same endpoints:
 *   - REST:  GET /health, GET /api/v1/state, GET /api/v1/screen,
 *            POST /api/v1/game/new, /api/v1/multiplayer/{host,join,leave},
 *            /api/v1/game/{pause,resume,quit}, GET/POST /api/v1/chat
 *            (operationIds from docs/openapi.yaml)
 *   - WebSocket ws://<host>/ws: game.state, game.deltas, game.events,
 *            game.chat; commands via {type:"command", operationId, body}
 *            (docs/websocket.md)
 *
 * It never touches the engine, the WASM module, or its memory, and never
 * calls window.ROTT input injection directly: agents play through the
 * sidecar, exactly as in ui/app.js. Vanilla JS, no dependencies.
 */
"use strict";

(function () {
  var REGISTRY_KEY = "rott.agents.v1";
  var SETTINGS_KEY = "rott.ui.settings.v1";
  var PANEL_ID = "rott-agent-panel";
  var TOGGLE_ID = "rott-agent-panel-toggle";

  var state = {
    ws: null,
    connected: false,
    restUrl: "http://localhost:8787",
    wsUrl: "ws://localhost:8787/ws",
    agents: [], // {id, name, endpoint, token?, remember}
    selectedAgents: new Set(),
    lastScreenHash: null,
    chatSeen: new Set(),
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  // ---- Panel DOM (built by this script; web/index.html is untouched) ----

  function buildPanel() {
    if ($(PANEL_ID)) return;

    var style = document.createElement("style");
    style.textContent =
      "#" + TOGGLE_ID + " { position: fixed; right: 12px; top: 12px; z-index: 1000;" +
      " font-size: 1rem; padding: 8px 14px; cursor: pointer;" +
      " background: #c33; color: #fff; border: 0; border-radius: 6px; }" +
      "#" + TOGGLE_ID + ":hover { background: #e04444; }" +
      "#" + PANEL_ID + " { position: fixed; right: 12px; top: 56px; z-index: 1000;" +
      " width: min(92vw, 380px); max-height: calc(100vh - 72px); overflow-y: auto;" +
      " background: #14141c; color: #e8e8ec; border: 1px solid #444; border-radius: 8px;" +
      " padding: 12px 14px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;" +
      " font-size: 0.9rem; line-height: 1.45; box-shadow: 0 8px 28px rgba(0,0,0,0.6); }" +
      "#" + PANEL_ID + "[hidden] { display: none; }" +
      "#" + PANEL_ID + " h2 { font-size: 1rem; margin: 14px 0 6px; }" +
      "#" + PANEL_ID + " h2:first-child { margin-top: 0; }" +
      "#" + PANEL_ID + " .muted { color: #9a9aad; }" +
      "#" + PANEL_ID + " label { display: block; margin: 6px 0; }" +
      "#" + PANEL_ID + " input, #" + PANEL_ID + " select { width: 100%; box-sizing: border-box;" +
      " margin-top: 2px; padding: 6px; background: #22222c; color: #e8e8ec;" +
      " border: 1px solid #444; border-radius: 4px; }" +
      "#" + PANEL_ID + " input[type=checkbox] { width: auto; }" +
      "#" + PANEL_ID + " button { cursor: pointer; padding: 6px 10px; margin: 2px 2px 2px 0;" +
      " background: #2a2a36; color: #e8e8ec; border: 1px solid #555; border-radius: 4px; }" +
      "#" + PANEL_ID + " button:hover { background: #3a3a48; }" +
      "#" + PANEL_ID + " .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }" +
      "#" + PANEL_ID + " ul, #" + PANEL_ID + " ol { margin: 6px 0; padding-left: 20px; }" +
      "#" + PANEL_ID + " #rott-panel-chat-log { max-height: 160px; overflow-y: auto;" +
      " list-style: none; padding: 0; }" +
      "#" + PANEL_ID + " #rott-panel-chat-log li { margin: 4px 0; }" +
      "#" + PANEL_ID + " #rott-panel-screen { width: 100%; display: block; margin-top: 6px;" +
      " background: #000; image-rendering: pixelated; }" +
      "#" + PANEL_ID + " #rott-panel-screen[hidden] { display: none; }" +
      "#" + PANEL_ID + " .status.offline { color: #e08a8a; }" +
      "#" + PANEL_ID + " .status.online { color: #8ae08a; }";
    document.head.appendChild(style);

    var toggle = document.createElement("button");
    toggle.id = TOGGLE_ID;
    toggle.type = "button";
    toggle.textContent = "Agents";
    toggle.title = "Show or hide the agent panel (shortcut: p)";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", PANEL_ID);
    toggle.addEventListener("click", togglePanel);
    document.body.appendChild(toggle);

    var panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "Agent launcher and chat steering panel");
    panel.innerHTML =
      "<h2>Agent panel</h2>" +
      "<p class=\"muted\">Custom / local agents only — no built-in list. " +
      "Talks to the game only through the sidecar (REST + WebSocket).</p>" +
      "<h2>Connection</h2>" +
      "<label>Sidecar REST base URL" +
      "<input id=\"rott-panel-rest-url\" type=\"url\" value=\"http://localhost:8787\"></label>" +
      "<label>Sidecar WebSocket URL" +
      "<input id=\"rott-panel-ws-url\" type=\"url\" value=\"ws://localhost:8787/ws\"></label>" +
      "<div class=\"row\">" +
      "<button id=\"rott-panel-connect-btn\" type=\"button\">Connect</button>" +
      "<button id=\"rott-panel-disconnect-btn\" type=\"button\" disabled>Disconnect</button>" +
      "<span id=\"rott-panel-conn-status\" class=\"status offline\">offline</span> " +
      "<span id=\"rott-panel-conn-detail\" class=\"muted\">Not connected.</span>" +
      "</div>" +
      "<h2>Agent registry</h2>" +
      "<form id=\"rott-panel-add-agent-form\">" +
      "<input id=\"rott-panel-agent-name\" type=\"text\" placeholder=\"Agent name (e.g. agent-1)\" required>" +
      "<input id=\"rott-panel-agent-endpoint\" type=\"url\" placeholder=\"Agent endpoint URL (e.g. http://localhost:9101)\" required>" +
      "<input id=\"rott-panel-agent-token\" type=\"password\" placeholder=\"Credential / token (optional)\" autocomplete=\"off\">" +
      "<label class=\"inline\"><input id=\"rott-panel-agent-remember\" type=\"checkbox\"> remember credential</label>" +
      "<button type=\"submit\">Add agent</button>" +
      "</form>" +
      "<ul id=\"rott-panel-agent-list\"></ul>" +
      "<h2>Launch a match</h2>" +
      "<label>Mode" +
      "<select id=\"rott-panel-launch-mode\">" +
      "<option value=\"comm-bat\">Comm-bat (deathmatch)</option>" +
      "<option value=\"cooperative\">Cooperative</option>" +
      "<option value=\"score-attack\">Score / time attack (single-player)</option>" +
      "</select></label>" +
      "<label>Episode" +
      "<select id=\"rott-panel-launch-episode\">" +
      "<option value=\"1\">1</option><option value=\"2\">2</option><option value=\"3\">3</option>" +
      "</select></label>" +
      "<label>Level <input id=\"rott-panel-launch-level\" type=\"number\" min=\"1\" value=\"1\"></label>" +
      "<label>Difficulty" +
      "<select id=\"rott-panel-launch-difficulty\">" +
      "<option value=\"easy\">easy</option>" +
      "<option value=\"normal\" selected>normal</option>" +
      "<option value=\"hard\">hard</option>" +
      "<option value=\"very-hard\">very-hard</option>" +
      "</select></label>" +
      "<label>Max players <input id=\"rott-panel-launch-max-players\" type=\"number\" min=\"2\" max=\"11\" value=\"4\"></label>" +
      "<label>Join address (for Join)" +
      "<input id=\"rott-panel-launch-address\" type=\"text\" placeholder=\"host address\"></label>" +
      "<p class=\"muted\">Select agents in the registry to play. Comm-bat needs at least 2; " +
      "score attack needs at least 1.</p>" +
      "<div class=\"row\">" +
      "<button id=\"rott-panel-host-btn\" type=\"button\">Host match</button>" +
      "<button id=\"rott-panel-join-btn\" type=\"button\">Join</button>" +
      "<button id=\"rott-panel-leave-btn\" type=\"button\">Leave</button>" +
      "<button id=\"rott-panel-pause-btn\" type=\"button\">Pause</button>" +
      "<button id=\"rott-panel-resume-btn\" type=\"button\">Resume</button>" +
      "<button id=\"rott-panel-quit-btn\" type=\"button\">Quit game</button>" +
      "</div>" +
      "<p id=\"rott-panel-launch-status\" class=\"muted\" role=\"status\"></p>" +
      "<h2>Chat steering</h2>" +
      "<p class=\"muted\">Messages go to the playing agent through the sidecar " +
      "(sendChat / game.chat), never into the engine.</p>" +
      "<ol id=\"rott-panel-chat-log\" aria-live=\"polite\"></ol>" +
      "<form id=\"rott-panel-chat-form\" class=\"row\">" +
      "<select id=\"rott-panel-chat-to\" title=\"Recipient (blank = broadcast)\">" +
      "<option value=\"\">broadcast</option>" +
      "</select>" +
      "<input id=\"rott-panel-chat-text\" type=\"text\" placeholder=\"Steer the agent…\" required>" +
      "<button type=\"submit\">Send</button>" +
      "</form>" +
      "<h2>Spectator view</h2>" +
      "<div id=\"rott-panel-state-readout\" class=\"muted\">No state yet — connect to the sidecar.</div>" +
      "<img id=\"rott-panel-screen\" alt=\"Live game screen (updates when the state changes)\" hidden>";
    document.body.appendChild(panel);
  }

  function togglePanel() {
    var panel = $(PANEL_ID);
    var toggle = $(TOGGLE_ID);
    if (!panel || !toggle) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  }

  // ---- Settings + registry (same keys as ui/app.js) ----

  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (saved.restUrl) state.restUrl = saved.restUrl;
      if (saved.wsUrl) state.wsUrl = saved.wsUrl;
    } catch (e) {
      // corrupted settings: fall back to defaults
    }
    $("rott-panel-rest-url").value = state.restUrl;
    $("rott-panel-ws-url").value = state.wsUrl;
  }

  function saveSettings() {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ restUrl: state.restUrl, wsUrl: state.wsUrl })
    );
  }

  function loadAgents() {
    try {
      state.agents = JSON.parse(localStorage.getItem(REGISTRY_KEY) || "[]");
    } catch (e) {
      state.agents = [];
    }
    // Tokens saved only when the user ticked "remember"; others are dropped.
    for (var i = 0; i < state.agents.length; i++) {
      if (!state.agents[i].remember) delete state.agents[i].token;
    }
    renderAgents();
  }

  function saveAgents() {
    var stored = state.agents.map(function (agent) {
      var copy = {};
      for (var k in agent) copy[k] = agent[k];
      if (!copy.remember) delete copy.token;
      return copy;
    });
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(stored));
  }

  function renderAgents() {
    var list = $("rott-panel-agent-list");
    list.innerHTML = "";
    var chatTo = $("rott-panel-chat-to");
    chatTo.innerHTML = '<option value="">broadcast</option>';
    if (state.agents.length === 0) {
      list.innerHTML = '<li class="muted">No agents yet — add a custom or local agent above.</li>';
      return;
    }
    state.agents.forEach(function (agent) {
      var li = document.createElement("li");
      var checked = state.selectedAgents.has(agent.id) ? "checked" : "";
      li.innerHTML =
        "<label><input type=\"checkbox\" data-agent=\"" + esc(agent.id) + "\" " + checked + "> " +
        "<strong>" + esc(agent.name) + "</strong> <span class=\"muted\">" + esc(agent.endpoint) + "</span></label> " +
        "<button data-remove=\"" + esc(agent.id) + "\" type=\"button\">Remove</button>";
      list.appendChild(li);
      var option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.name;
      chatTo.appendChild(option);
    });
  }

  // ---- Sidecar transport (same functions/endpoints as ui/app.js) ----

  function setConnStatus(online, detail) {
    state.connected = online;
    var badge = $("rott-panel-conn-status");
    badge.textContent = online ? "online" : "offline";
    badge.className = "status " + (online ? "online" : "offline");
    $("rott-panel-conn-detail").textContent = detail;
    $("rott-panel-connect-btn").disabled = online;
    $("rott-panel-disconnect-btn").disabled = !online;
  }

  function rest(path, options) {
    options = options || {};
    var headers = { "content-type": "application/json" };
    return fetch(state.restUrl + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body,
    }).then(function (res) {
      return res.text().then(function (text) {
        var data;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch (e) {
          data = text;
        }
        if (!res.ok) {
          var message =
            (data && data.error && data.error.message) ||
            (data && data.message) ||
            ("HTTP " + res.status);
          throw new Error(message);
        }
        return data;
      });
    });
  }

  function connect() {
    state.restUrl = $("rott-panel-rest-url").value.replace(/\/+$/, "");
    state.wsUrl = $("rott-panel-ws-url").value;
    saveSettings();
    setConnStatus(false, "Connecting…");
    return rest("/health")
      .then(function (health) {
        setConnStatus(
          true,
          "Sidecar OK (bridge " + (health.bridgeConnected ? "connected" : "not connected") + ")."
        );
        connectWs();
        refreshState();
        refreshChat();
      })
      .catch(function (error) {
        setConnStatus(false, "REST failed: " + error.message);
      });
  }

  function disconnect() {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    setConnStatus(false, "Disconnected.");
  }

  function connectWs() {
    if (state.ws) state.ws.close();
    var ws;
    try {
      ws = new WebSocket(state.wsUrl);
    } catch (error) {
      $("rott-panel-conn-detail").textContent += " WebSocket failed: " + error.message;
      return;
    }
    state.ws = ws;
    ws.onopen = function () {
      ws.send(JSON.stringify({
        type: "subscribe",
        channels: ["game.state", "game.deltas", "game.events", "game.chat"],
      }));
    };
    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (msg.type === "game.state") renderState(msg.payload);
      else if (msg.type === "game.deltas" && msg.payload && msg.payload.changed) {
        renderStateDelta(msg.payload.changed);
      } else if (msg.type === "game.chat") addChatMessage(msg.payload);
      else if (msg.type === "game.events") {
        addChatMessage({
          from: "system",
          text: "event: " + ((msg.payload && msg.payload.kind) || msg.type),
          ts: msg.ts,
        });
      }
    };
    ws.onclose = function () {
      if (state.ws === ws) {
        state.ws = null;
        $("rott-panel-conn-detail").textContent += " WebSocket closed; REST polling continues.";
      }
    };
    ws.onerror = function () {
      $("rott-panel-conn-detail").textContent += " WebSocket error; REST polling continues.";
    };
  }

  function renderState(s) {
    if (!s) return;
    var fmt = function (v) {
      return v === null || v === undefined ? "—" : v;
    };
    $("rott-panel-state-readout").textContent =
      "status: " + fmt(s.status) + " · episode " + fmt(s.episode) + " level " + fmt(s.level) +
      " (" + fmt(s.levelName) + ") · difficulty " + fmt(s.difficulty) + " · " +
      "health " + fmt(s.health) + " · armor " + fmt(s.armor) + " · score " + fmt(s.score) + " · " +
      "bridge " + (s.bridgeConnected ? "connected" : "not connected");
    if (s.screenHash && s.screenHash !== state.lastScreenHash) {
      state.lastScreenHash = s.screenHash;
      refreshScreen();
    }
    if (s.screenDataUrl) {
      var img = $("rott-panel-screen");
      img.src = s.screenDataUrl;
      img.hidden = false;
    }
  }

  function renderStateDelta(changed) {
    // Deltas are partial; re-read the full state rather than guessing.
    void changed;
    refreshState();
  }

  function refreshState() {
    if (!state.connected) return Promise.resolve();
    return rest("/api/v1/state")
      .then(renderState)
      .catch(function () {
        // transient; the next tick retries
      });
  }

  function refreshScreen() {
    return rest("/api/v1/screen")
      .then(function (shot) {
        if (shot && shot.base64) {
          var img = $("rott-panel-screen");
          img.src = "data:image/png;base64," + shot.base64;
          img.hidden = false;
        }
      })
      .catch(function () {
        // no fresh frame; keep the last one
      });
  }

  function addChatMessage(msg) {
    if (!msg || typeof msg.text !== "string") return;
    var key = (msg.ts || "") + "|" + (msg.from || "") + "|" + msg.text;
    if (state.chatSeen.has(key)) return;
    state.chatSeen.add(key);
    var li = document.createElement("li");
    var when = msg.ts ? new Date(msg.ts).toLocaleTimeString() : "";
    li.innerHTML =
      "<span class=\"muted\">" + esc(when) + "</span> " +
      "<strong>" + esc(msg.from || "unknown") + "</strong>" +
      (msg.to ? " → <em>" + esc(msg.to) + "</em>" : "") +
      ": " + esc(msg.text);
    var log = $("rott-panel-chat-log");
    log.appendChild(li);
    while (log.children.length > 200) {
      log.removeChild(log.firstChild);
    }
    log.scrollTop = log.scrollHeight;
  }

  function refreshChat() {
    if (!state.connected) return Promise.resolve();
    return rest("/api/v1/chat")
      .then(function (messages) {
        if (Array.isArray(messages)) {
          messages.forEach(addChatMessage);
        }
      })
      .catch(function () {
        // transient
      });
  }

  function sendChatMessage(text, to) {
    var body = { from: "user", text: text, to: to || null };
    return rest("/api/v1/chat", { method: "POST", body: JSON.stringify(body) }).then(function () {
      var msg = { from: body.from, text: body.text, to: body.to, ts: new Date().toISOString() };
      addChatMessage(msg);
    });
  }

  function selectedAgentNames() {
    return state.agents
      .filter(function (a) { return state.selectedAgents.has(a.id); })
      .map(function (a) { return a.name; });
  }

  function launch(action) {
    var status = $("rott-panel-launch-status");
    var mode = $("rott-panel-launch-mode").value;
    var episode = Number($("rott-panel-launch-episode").value);
    var level = Number($("rott-panel-launch-level").value);
    var difficulty = $("rott-panel-launch-difficulty").value;
    var maxPlayers = Number($("rott-panel-launch-max-players").value);
    var agents = selectedAgentNames();
    var step;
    if (action === "host") {
      if (mode === "score-attack") {
        if (agents.length < 1) {
          status.textContent = "Failed: Select at least 1 agent for score attack.";
          return Promise.resolve();
        }
        step = rest("/api/v1/game/new", {
          method: "POST",
          body: JSON.stringify({ episode: episode, level: level, difficulty: difficulty }),
        }).then(function () {
          status.textContent =
            "Score attack started: " + agents.join(", ") +
            " — episode " + episode + ", level " + level + ", " + difficulty + ".";
        });
      } else {
        if (agents.length < 2 && mode === "comm-bat") {
          status.textContent = "Failed: Select at least 2 agents for a Comm-bat deathmatch.";
          return Promise.resolve();
        }
        step = rest("/api/v1/multiplayer/host", {
          method: "POST",
          body: JSON.stringify({ mode: mode, maxPlayers: maxPlayers, episode: episode, level: level }),
        }).then(function () {
          status.textContent =
            "Hosting " + mode + " for " + (agents.join(", ") || "players") +
            " — episode " + episode + ", level " + level + ", max " + maxPlayers + " players.";
        });
      }
    } else if (action === "join") {
      var address = $("rott-panel-launch-address").value.trim();
      if (!address) {
        status.textContent = "Failed: Enter a host address to join.";
        return Promise.resolve();
      }
      step = rest("/api/v1/multiplayer/join", {
        method: "POST",
        body: JSON.stringify({ address: address, playerName: agents[0] || "player-1" }),
      }).then(function () {
        status.textContent = "Joining " + address + "…";
      });
    } else if (action === "leave") {
      step = rest("/api/v1/multiplayer/leave", { method: "POST", body: "{}" }).then(function () {
        status.textContent = "Left the multiplayer game.";
      });
    } else if (action === "pause") {
      step = rest("/api/v1/game/pause", { method: "POST", body: "{}" }).then(function () {
        status.textContent = "Paused.";
      });
    } else if (action === "resume") {
      step = rest("/api/v1/game/resume", { method: "POST", body: "{}" }).then(function () {
        status.textContent = "Resumed.";
      });
    } else if (action === "quit") {
      step = rest("/api/v1/game/quit", { method: "POST", body: "{}" }).then(function () {
        status.textContent = "Game quit.";
      });
    } else {
      return Promise.resolve();
    }
    return step
      .then(function () { refreshState(); })
      .catch(function (error) {
        status.textContent = "Failed: " + error.message;
      });
  }

  // ---- Wiring ----

  function init() {
    buildPanel();
    loadSettings();
    loadAgents();

    $("rott-panel-connect-btn").addEventListener("click", connect);
    $("rott-panel-disconnect-btn").addEventListener("click", disconnect);

    $("rott-panel-add-agent-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var name = $("rott-panel-agent-name").value.trim();
      var endpoint = $("rott-panel-agent-endpoint").value.trim();
      var token = $("rott-panel-agent-token").value;
      var remember = $("rott-panel-agent-remember").checked;
      if (!name || !endpoint) return;
      state.agents.push({
        id: "agent-" + Date.now().toString(36),
        name: name,
        endpoint: endpoint,
        token: token || undefined,
        remember: remember,
      });
      saveAgents();
      renderAgents();
      event.target.reset();
    });

    $("rott-panel-agent-list").addEventListener("click", function (event) {
      var removeId = event.target.dataset ? event.target.dataset.remove : null;
      if (removeId) {
        state.agents = state.agents.filter(function (a) { return a.id !== removeId; });
        state.selectedAgents.delete(removeId);
        saveAgents();
        renderAgents();
      }
    });
    $("rott-panel-agent-list").addEventListener("change", function (event) {
      var id = event.target.dataset ? event.target.dataset.agent : null;
      if (!id) return;
      if (event.target.checked) state.selectedAgents.add(id);
      else state.selectedAgents.delete(id);
    });

    $("rott-panel-host-btn").addEventListener("click", function () { launch("host"); });
    $("rott-panel-join-btn").addEventListener("click", function () { launch("join"); });
    $("rott-panel-leave-btn").addEventListener("click", function () { launch("leave"); });
    $("rott-panel-pause-btn").addEventListener("click", function () { launch("pause"); });
    $("rott-panel-resume-btn").addEventListener("click", function () { launch("resume"); });
    $("rott-panel-quit-btn").addEventListener("click", function () { launch("quit"); });

    $("rott-panel-chat-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var text = $("rott-panel-chat-text").value.trim();
      if (!text) return;
      var toId = $("rott-panel-chat-to").value;
      var found = null;
      for (var i = 0; i < state.agents.length; i++) {
        if (state.agents[i].id === toId) found = state.agents[i];
      }
      var to = toId ? (found ? found.name : null) : null;
      sendChatMessage(text, to)
        .then(function () {
          $("rott-panel-chat-text").value = "";
        })
        .catch(function (error) {
          addChatMessage({
            from: "system",
            text: "chat failed: " + error.message,
            ts: new Date().toISOString(),
          });
        });
    });

    // `p` toggles the panel — only when the game canvas is not focused,
    // so it never steals a gameplay key.
    document.addEventListener("keydown", function (event) {
      if (event.key !== "p" && event.key !== "P") return;
      var active = document.activeElement;
      if (active && (active.id === "rott-canvas" || active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
      togglePanel();
    });

    // REST polling fallback: state every 2 s, chat every 5 s (matches the
    // sidecar's 2 s state tick; WebSocket pushes arrive sooner when live).
    setInterval(refreshState, 2000);
    setInterval(refreshChat, 5000);
  }

  // Public handle for the game page and for tests: the same entry points
  // ui/app.js exposes, namespaced so they cannot collide with it.
  window.RottUiPanel = {
    toggle: togglePanel,
    connect: connect,
    disconnect: disconnect,
    launch: launch,
    sendChatMessage: sendChatMessage,
    refreshState: refreshState,
    refreshChat: refreshChat,
    refreshScreen: refreshScreen,
    get agents() {
      return state.agents.slice();
    },
    get connected() {
      return state.connected;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
