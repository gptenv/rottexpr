// SPDX-License-Identifier: MIT
// Smoke test for the sidecar /ws channel.
//
// Landed from lane-2's `.verify/ws-smoke.mjs`, adapted: the original
// imported the `ws` package through an absolute workspace path
// (`/home/hatch/workspace/rott-fleet/lane-2-sidecar/.verify/node_modules/ws/wrapper.mjs`);
// this copy imports `ws` from `server/package.json` instead, so it runs
// anywhere the sidecar's dependencies are installed (`npm install` in
// `server/`). Everything else is unchanged.
//
// Run against a live sidecar (default port 8787):
//   node server/tests/ws-smoke.mjs
// Or as part of the chain check: `node scripts/e2e-local.mjs`
import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:8787/ws");
const seen = [];
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", channels: ["game.state", "game.deltas", "game.chat"] }));
  ws.send(JSON.stringify({ type: "command", operationId: "getState" }));
  ws.send(JSON.stringify({ type: "command", operationId: "sendKey", body: { key: "ArrowUp", action: "press" } }));
  ws.send(JSON.stringify({ type: "command", operationId: "sendChat", body: { from: "ws-test", text: "hello over ws", to: null } }));
  ws.send(JSON.stringify({ type: "ping" }));
});
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  seen.push(msg.type + (msg.payload && msg.payload.operationId ? ":" + msg.payload.operationId : ""));
  if (msg.type === "pong") {
    console.log("WS-SEEN:", JSON.stringify(seen));
    console.log("WS-OK");
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (e) => { console.error("WS-ERROR", e.message); process.exit(1); });
setTimeout(() => { console.error("WS-TIMEOUT seen:", JSON.stringify(seen)); process.exit(1); }, 10000);
