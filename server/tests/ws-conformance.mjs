// SPDX-License-Identifier: MIT
// WebSocket conformance test for the ROTT sidecar (/ws).
//
// Subscribes to all four channels (game.state, game.events, game.deltas,
// game.chat), checks the {type, seq, ts, payload} envelope on every message,
// exercises ping/pong, subscribe/unsubscribe, and the bidirectional
// `command` channel (same handlers as REST, see docs/websocket.md), and
// verifies per-client channel isolation with a second connection.
//
// Run against a live sidecar (no bridge/game page required — the test
// accepts either outcome for bridge-dependent commands and says which it
// saw):
//   npm run build && npm start            # in server/ (default port 8787)
//   node server/tests/ws-conformance.mjs [--url ws://localhost:8787/ws]
//
// Exit 0 when every step passes, 1 otherwise. Prints one PASS/FAIL line
// per step plus a summary. Requires the `ws` package (server dependency).
//
// What it deliberately does NOT assert: a live `game.deltas` push needs a
// connected bridge observing a real state change, and `game.events` needs
// a bridge/game event to happen. With no bridge attached those messages
// simply never arrive — the test records that (and validates the shape of
// any delta/event that does arrive, e.g. on a run with a bridge attached)
// instead of failing. A live-browser, live-game match still needs a
// Chrome run (see docs/chrome-verification.md).

import WebSocket from "ws";

const DEFAULT_URL = "ws://localhost:8787/ws";
const url = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]
  : process.env.ROTT_WS_URL ?? DEFAULT_URL;
const timeoutMs = Number(
  process.env.ROTT_WS_TIMEOUT_MS ??
    (process.argv.includes("--timeout-ms")
      ? process.argv[process.argv.indexOf("--timeout-ms") + 1]
      : 20000),
);

const CHANNELS = ["game.state", "game.events", "game.deltas", "game.chat"];
const STATE_KEYS = [
  "status",
  "bridgeConnected",
  "episode",
  "level",
  "levelName",
  "difficulty",
  "health",
  "armor",
  "ammo",
  "weapons",
  "score",
  "lives",
  "screenHash",
  "screenCapturedAt",
  "hudText",
  "saveSlots",
  "updatedAt",
];

let passed = 0;
let failed = 0;
const notes = [];
function pass(name, detail = "") {
  passed += 1;
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  failed += 1;
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}
function note(text) {
  notes.push(text);
  console.log(`NOTE ${text}`);
}

function isIsoTs(v) {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

// Per-connection message log with envelope validation. Every message the
// server sends must be {type: string, seq: number, ts: ISO, payload: any}
// with seq strictly increasing on that connection (seq is server-wide, so
// gaps are fine when other clients are connected, but it must never go
// backwards or repeat).
class Client {
  constructor(name, wsUrl) {
    this.name = name;
    this.ws = new WebSocket(wsUrl);
    this.messages = [];
    this.lastSeq = -1;
    this.envelopeBad = [];
    this.waiters = [];
    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf-8"));
      } catch {
        this.envelopeBad.push(`non-JSON frame: ${raw.toString("utf-8").slice(0, 80)}`);
        return;
      }
      this.messages.push(msg);
      if (
        typeof msg.type !== "string" ||
        typeof msg.seq !== "number" ||
        !isIsoTs(msg.ts) ||
        !("payload" in msg)
      ) {
        this.envelopeBad.push(`bad envelope: ${JSON.stringify(msg).slice(0, 200)}`);
      } else if (msg.seq <= this.lastSeq) {
        this.envelopeBad.push(`seq not increasing: ${msg.seq} after ${this.lastSeq}`);
      } else {
        this.lastSeq = msg.seq;
      }
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    this.ws.on("error", (err) => {
      for (const w of this.waiters.splice(0)) w.reject(err);
    });
  }

  get open() {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(obj) {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  waitFor(pred, ms = 5000, label = "message") {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error(`timed out after ${ms}ms waiting for ${label}`));
      }, ms);
    });
  }

  count(type) {
    return this.messages.filter((m) => m.type === type).length;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

function commandResult(client, operationId, ms = 5000) {
  return client.waitFor(
    (m) => m.type === "command.result" && m.payload?.operationId === operationId,
    ms,
    `command.result:${operationId}`,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const overall = setTimeout(() => {
    console.error(`FAIL overall timeout (${timeoutMs}ms)`);
    process.exit(1);
  }, timeoutMs);
  overall.unref?.();

  const c1 = new Client("client-1", url);
  try {
    await c1.open;
  } catch (err) {
    fail("connect", `could not connect to ${url}: ${err.message}`);
    console.log(`\nws-conformance: ${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  // 1. hello on connect: channel list + current state.
  try {
    const hello = await c1.waitFor((m) => m.type === "hello", 5000, "hello");
    const channels = hello.payload?.channels ?? [];
    const hasAll = CHANNELS.every((ch) => channels.includes(ch));
    const stateOk =
      hello.payload?.state && typeof hello.payload.state.status === "string";
    if (hasAll && stateOk) {
      pass("hello lists all 4 channels + current state", `channels=${channels.join(",")}`);
    } else {
      fail("hello lists all 4 channels + current state", JSON.stringify(hello.payload).slice(0, 200));
    }
  } catch (err) {
    fail("hello lists all 4 channels + current state", err.message);
  }

  // 2. Subscribe to all four channels; expect the subscribed echo plus an
  //    immediate full game.state.
  c1.send({ type: "subscribe", channels: CHANNELS });
  try {
    const sub = await c1.waitFor(
      (m) => m.type === "subscribed" && m.payload?.channels?.length === 4,
      5000,
      "subscribed (4 channels)",
    );
    pass("subscribe all 4 channels", `echo=${sub.payload.channels.join(",")}`);
  } catch (err) {
    fail("subscribe all 4 channels", err.message);
  }
  try {
    const state = await c1.waitFor((m) => m.type === "game.state", 5000, "game.state");
    const missing = STATE_KEYS.filter((k) => !(k in (state.payload ?? {})));
    if (missing.length === 0) {
      pass(
        "game.state on subscribe (full ObservableState)",
        `status=${state.payload.status} bridgeConnected=${state.payload.bridgeConnected}`,
      );
    } else {
      fail("game.state on subscribe (full ObservableState)", `missing keys: ${missing.join(",")}`);
    }
  } catch (err) {
    fail("game.state on subscribe (full ObservableState)", err.message);
  }

  // 3. ping / pong keepalive.
  c1.send({ type: "ping" });
  try {
    await c1.waitFor((m) => m.type === "pong", 5000, "pong");
    pass("ping/pong keepalive");
  } catch (err) {
    fail("ping/pong keepalive", err.message);
  }

  // 4. command: getState — same handler as GET /api/v1/state.
  c1.send({ type: "command", operationId: "getState" });
  try {
    const res = await commandResult(c1, "getState");
    if (res.payload?.status === 200 && typeof res.payload.body?.status === "string") {
      pass("command getState → 200 + ObservableState", `status=${res.payload.body.status}`);
    } else {
      fail("command getState → 200 + ObservableState", JSON.stringify(res.payload).slice(0, 200));
    }
  } catch (err) {
    fail("command getState → 200 + ObservableState", err.message);
  }

  // 5. command: sendChat — works with no bridge; must return the recorded
  //    message AND broadcast it on game.chat to subscribers.
  const chatText = `ws-conformance ${Date.now()}`;
  const chatBefore = c1.count("game.chat");
  c1.send({ type: "command", operationId: "sendChat", body: { from: "ws-conformance", text: chatText, to: null } });
  try {
    const res = await commandResult(c1, "sendChat");
    const okResult =
      res.payload?.status === 200 &&
      res.payload.body?.from === "ws-conformance" &&
      res.payload.body?.text === chatText;
    if (okResult) pass("command sendChat → 200 + echoed message");
    else fail("command sendChat → 200 + echoed message", JSON.stringify(res.payload).slice(0, 200));
  } catch (err) {
    fail("command sendChat → 200 + echoed message", err.message);
  }
  try {
    const bc = await c1.waitFor(
      (m) => m.type === "game.chat" && m.payload?.text === chatText,
      5000,
      "game.chat broadcast",
    );
    if (bc.payload?.from === "ws-conformance") {
      pass("game.chat broadcast reaches subscribers", `seen=${c1.count("game.chat") - chatBefore} new`);
    } else {
      fail("game.chat broadcast reaches subscribers", JSON.stringify(bc.payload).slice(0, 200));
    }
  } catch (err) {
    fail("game.chat broadcast reaches subscribers", err.message);
  }

  // 6. command: sendKey — needs the bridge. With no game page attached the
  //    honest result is 503 BRIDGE_OFFLINE; with a bridge it is 200
  //    accepted. Either is conformant; the test records which it saw.
  c1.send({ type: "command", operationId: "sendKey", body: { key: "ArrowUp", action: "press" } });
  try {
    const res = await commandResult(c1, "sendKey");
    if (res.payload?.status === 200 && res.payload.body?.accepted === true) {
      pass("command sendKey → 200 accepted (bridge connected)");
    } else if (
      res.payload?.status === 503 &&
      res.payload.error?.code === "BRIDGE_OFFLINE"
    ) {
      pass("command sendKey → 503 BRIDGE_OFFLINE (no bridge attached)");
    } else {
      fail("command sendKey → 200 or 503 BRIDGE_OFFLINE", JSON.stringify(res.payload).slice(0, 200));
    }
  } catch (err) {
    fail("command sendKey → 200 or 503 BRIDGE_OFFLINE", err.message);
  }

  // 7. command: unknown operationId → 404 NOT_FOUND, not a crash.
  c1.send({ type: "command", operationId: "noSuchOperation" });
  try {
    const res = await commandResult(c1, "noSuchOperation");
    if (res.payload?.status === 404 && res.payload.error?.code === "NOT_FOUND") {
      pass("command unknown operationId → 404 NOT_FOUND");
    } else {
      fail("command unknown operationId → 404 NOT_FOUND", JSON.stringify(res.payload).slice(0, 200));
    }
  } catch (err) {
    fail("command unknown operationId → 404 NOT_FOUND", err.message);
  }

  // 8. command: invalid body → 400 BAD_REQUEST (sendChat without text).
  c1.send({ type: "command", operationId: "sendChat", body: { from: "ws-conformance" } });
  try {
    // Wait specifically for a 400 result — an earlier 200 sendChat result
    // is already in the log, so a plain commandResult() would match it.
    const bad = await c1.waitFor(
      (m) =>
        m.type === "command.result" &&
        m.payload?.operationId === "sendChat" &&
        m.payload?.status === 400,
      5000,
      "command.result sendChat 400",
    );
    if (bad.payload?.error?.code === "BAD_REQUEST") {
      pass("command sendChat with bad body → 400 BAD_REQUEST");
    } else {
      fail("command sendChat with bad body → 400 BAD_REQUEST", JSON.stringify(bad.payload).slice(0, 200));
    }
  } catch (err) {
    fail("command sendChat with bad body → 400 BAD_REQUEST", err.message);
  }

  // 9. Malformed JSON → {type: "error"} reply, connection stays alive.
  c1.send("{not json");
  try {
    const errMsg = await c1.waitFor(
      (m) => m.type === "error" && /JSON/.test(String(m.payload?.message ?? "")),
      5000,
      "error for malformed JSON",
    );
    pass("malformed JSON → error reply", String(errMsg.payload.message));
  } catch (err) {
    fail("malformed JSON → error reply", err.message);
  }

  // 10. Unknown message type → {type: "error"} reply, connection stays alive.
  c1.send({ type: "teleport", channels: [] });
  try {
    const errMsg = await c1.waitFor(
      (m) => m.type === "error" && /Unknown message type/.test(String(m.payload?.message ?? "")),
      5000,
      "error for unknown type",
    );
    pass("unknown message type → error reply", String(errMsg.payload.message));
  } catch (err) {
    fail("unknown message type → error reply", err.message);
  }
  // Connection still alive after the two errors: ping again.
  c1.send({ type: "ping" });
  try {
    await c1.waitFor((m) => m.type === "pong", 5000, "pong after errors");
    pass("connection stays alive after error replies");
  } catch (err) {
    fail("connection stays alive after error replies", err.message);
  }

  // 11. Unsubscribe game.chat: a later chat must NOT be broadcast to c1
  //     (the direct command.result still comes back — that is a reply,
  //     not a broadcast).
  c1.send({ type: "unsubscribe", channels: ["game.chat"] });
  try {
    const sub = await c1.waitFor(
      (m) => m.type === "subscribed" && !m.payload?.channels?.includes("game.chat"),
      5000,
      "subscribed without game.chat",
    );
    pass("unsubscribe game.chat", `remaining=${sub.payload.channels.join(",")}`);
  } catch (err) {
    fail("unsubscribe game.chat", err.message);
  }
  const chatCountBefore = c1.count("game.chat");
  const quietText = `ws-conformance-quiet ${Date.now()}`;
  c1.send({ type: "command", operationId: "sendChat", body: { from: "ws-conformance", text: quietText, to: null } });
  try {
    await commandResult(c1, "sendChat");
  } catch {
    // Already covered by step 5; ignore here.
  }
  await sleep(800);
  if (c1.count("game.chat") === chatCountBefore) {
    pass("unsubscribed client receives no game.chat broadcast");
  } else {
    fail(
      "unsubscribed client receives no game.chat broadcast",
      `got ${c1.count("game.chat") - chatCountBefore} unexpected broadcast(s)`,
    );
  }

  // 12. Second client, subscribed to game.chat only: channel isolation —
  //     it must NOT receive game.state (even across the 2 s tick), but it
  //     MUST receive the game.chat broadcast for a chat sent by c1.
  const c2 = new Client("client-2", url);
  try {
    await c2.open;
    await c2.waitFor((m) => m.type === "hello", 5000, "hello (client-2)");
    c2.send({ type: "subscribe", channels: ["game.chat"] });
    await c2.waitFor(
      (m) => m.type === "subscribed" && m.payload?.channels?.includes("game.chat"),
      5000,
      "subscribed (client-2)",
    );
    // Wait past one full 2 s state tick.
    await sleep(2500);
    if (c2.count("game.state") === 0) {
      pass("channel isolation: chat-only client gets no game.state across a tick");
    } else {
      fail("channel isolation: chat-only client gets no game.state across a tick", `got ${c2.count("game.state")}`);
    }
    const isoText = `ws-conformance-iso ${Date.now()}`;
    c1.send({ type: "command", operationId: "sendChat", body: { from: "ws-conformance", text: isoText, to: null } });
    try {
      const bc = await c2.waitFor(
        (m) => m.type === "game.chat" && m.payload?.text === isoText,
        5000,
        "game.chat on client-2",
      );
      if (bc.payload?.from === "ws-conformance") pass("game.chat broadcast reaches the other client");
      else fail("game.chat broadcast reaches the other client", JSON.stringify(bc.payload).slice(0, 200));
    } catch (err) {
      fail("game.chat broadcast reaches the other client", err.message);
    }
  } catch (err) {
    fail("second-client isolation checks", err.message);
  } finally {
    c2.close();
  }

  // 13. Fixed 2 s state tick: at least 2 game.state messages on c1
  //     (immediate on subscribe + at least one tick) by now.
  if (c1.count("game.state") >= 2) {
    pass("game.state 2 s tick delivers repeat full state", `received=${c1.count("game.state")}`);
  } else {
    fail("game.state 2 s tick delivers repeat full state", `received=${c1.count("game.state")}`);
  }

  // 14. Envelope validity across everything received on both clients.
  if (c1.envelopeBad.length === 0) {
    pass("envelope valid on every message (type/seq/ts/payload, seq increasing)", `${c1.messages.length} messages`);
  } else {
    fail("envelope valid on every message (type/seq/ts/payload, seq increasing)", c1.envelopeBad.slice(0, 3).join(" | "));
  }

  // 15. Optional live-only channels: validate shape if any arrived, but do
  //     not fail when none did (no bridge attached → no deltas/events).
  const deltas = c1.messages.filter((m) => m.type === "game.deltas");
  const events = c1.messages.filter((m) => m.type === "game.events");
  if (deltas.length > 0) {
    const okShape = deltas.every(
      (d) => d.payload && typeof d.payload.changed === "object" && Array.isArray(d.payload.removed),
    );
    if (okShape) pass("game.deltas shape valid (live delta observed)", `count=${deltas.length}`);
    else fail("game.deltas shape valid (live delta observed)", JSON.stringify(deltas[0]?.payload).slice(0, 200));
  } else {
    note("no game.deltas arrived — expected with no bridge attached (no state changes to push)");
  }
  if (events.length > 0) {
    const okShape = events.every((e) => typeof e.payload?.kind === "string");
    if (okShape) pass("game.events shape valid (live event observed)", `count=${events.length}`);
    else fail("game.events shape valid (live event observed)", JSON.stringify(events[0]?.payload).slice(0, 200));
  } else {
    note("no game.events arrived — expected with no bridge attached (no game events fired)");
  }

  // 16. includeScreen subscribe: a fresh client asking for screens gets a
  //     game.state carrying screenDataUrl (null with no frame available).
  const c3 = new Client("client-3", url);
  try {
    await c3.open;
    await c3.waitFor((m) => m.type === "hello", 5000, "hello (client-3)");
    c3.send({ type: "subscribe", channels: ["game.state"], includeScreen: true });
    const state = await c3.waitFor((m) => m.type === "game.state", 5000, "game.state with screen");
    if ("screenDataUrl" in (state.payload ?? {})) {
      pass("subscribe includeScreen → game.state carries screenDataUrl", `value=${state.payload.screenDataUrl === null ? "null (no frame yet)" : "present"}`);
    } else {
      fail("subscribe includeScreen → game.state carries screenDataUrl", "key missing");
    }
  } catch (err) {
    fail("subscribe includeScreen → game.state carries screenDataUrl", err.message);
  } finally {
    c3.close();
  }

  c1.close();
  clearTimeout(overall);
  console.log(`\nws-conformance: ${passed} passed, ${failed} failed`);
  if (notes.length > 0) console.log(`(${notes.length} note(s) — live-only channels not exercised without a bridge)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL ws-conformance crashed:", err);
  process.exit(1);
});
