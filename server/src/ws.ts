// SPDX-License-Identifier: MIT
// WebSocket hub for API clients (/ws). Channels: game.state, game.events,
// game.deltas, game.chat (see docs/websocket.md). Every message is JSON:
// {type, seq, ts, payload}. Bidirectional commands use the SAME handler
// functions as REST: a client sends {type:"command", operationId, params,
// body} and gets {type:"command.result", ...} back.

import type WebSocket from "ws";
import type { Handlers } from "./handlers.js";
import type { GameStateStore } from "./state.js";
import {
  ApiError,
  WS_CHANNELS,
  type ChatMessage,
  type ObservableState,
  type StateDelta,
  type WsChannel,
  type WsMessage,
} from "./types.js";

interface Client {
  ws: WebSocket;
  channels: Set<WsChannel>;
  includeScreen: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class WsHub {
  private clients = new Set<Client>();

  constructor(
    private readonly store: GameStateStore,
    private readonly handlers: Handlers,
  ) {}

  addClient(ws: WebSocket): void {
    const client: Client = { ws, channels: new Set(), includeScreen: false };
    this.clients.add(client);
    ws.on("message", (raw: Buffer) => {
      void this.handleMessage(client, raw).catch((err: unknown) => {
        this.send(client, "error", {
          message: err instanceof Error ? err.message : "Unknown error.",
        });
      });
    });
    ws.on("close", () => this.clients.delete(client));
    ws.on("error", () => this.clients.delete(client));
    // Greet with the channel list so clients can discover what exists.
    this.send(client, "hello", {
      channels: [...WS_CHANNELS],
      state: this.store.getState(),
    });
  }

  private send(client: Client, type: string, payload: unknown): void {
    if (client.ws.readyState !== 1) return; // OPEN
    const msg: WsMessage = {
      type,
      seq: this.store.nextSeq(),
      ts: new Date().toISOString(),
      payload,
    };
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {
      // Dead socket; the close handler cleans it up.
    }
  }

  private broadcast(type: string, channel: WsChannel, payload: unknown): void {
    for (const client of this.clients) {
      if (client.channels.has(channel)) this.send(client, type, payload);
    }
  }

  /** Full observable state, sent on subscribe and at the fixed tick. */
  broadcastState(state?: ObservableState): void {
    const current = state ?? this.store.getState();
    for (const client of this.clients) {
      if (!client.channels.has("game.state")) continue;
      const payload: Record<string, unknown> = { ...current };
      if (client.includeScreen) {
        const { png } = this.store.getScreen();
        payload.screenDataUrl = png !== null ? `data:image/png;base64,${png.toString("base64")}` : null;
      }
      this.send(client, "game.state", payload);
    }
  }

  /** Delta pushed whenever the observed state changes. */
  broadcastDelta(delta: StateDelta): void {
    this.broadcast("game.deltas", "game.deltas", delta);
  }

  broadcastEvent(kind: string, payload: unknown): void {
    this.broadcast("game.events", "game.events", { kind, ...((isRecord(payload) ? payload : { data: payload }) as Record<string, unknown>) });
  }

  broadcastChat(message: ChatMessage): void {
    this.broadcast("game.chat", "game.chat", message);
  }

  private async handleMessage(client: Client, raw: Buffer): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString("utf-8"));
    } catch {
      this.send(client, "error", { message: "Message must be JSON." });
      return;
    }
    if (!isRecord(msg) || typeof msg.type !== "string") {
      this.send(client, "error", { message: "Message needs a string 'type'." });
      return;
    }
    switch (msg.type) {
      case "ping":
        this.send(client, "pong", {});
        return;
      case "subscribe": {
        const channels = Array.isArray(msg.channels) ? msg.channels : [];
        for (const channel of channels as unknown[]) {
          if (typeof channel === "string" && (WS_CHANNELS as readonly string[]).includes(channel)) {
            client.channels.add(channel as WsChannel);
          }
        }
        if (msg.includeScreen === true) client.includeScreen = true;
        this.send(client, "subscribed", { channels: [...client.channels] });
        // Full state immediately on subscribe.
        if (client.channels.has("game.state")) this.broadcastState();
        return;
      }
      case "unsubscribe": {
        const channels = Array.isArray(msg.channels) ? msg.channels : [];
        for (const channel of channels as unknown[]) {
          client.channels.delete(channel as WsChannel);
        }
        this.send(client, "subscribed", { channels: [...client.channels] });
        return;
      }
      case "command": {
        const operationId = typeof msg.operationId === "string" ? msg.operationId : "";
        const params = isRecord(msg.params) ? (msg.params as Record<string, string>) : {};
        const body = "body" in msg ? msg.body : null;
        try {
          const result = await this.handlers.dispatch(operationId, params, body);
          this.send(client, "command.result", {
            operationId,
            status: result.status,
            body: result.body instanceof Buffer ? { base64: result.body.toString("base64") } : result.body,
          });
        } catch (err) {
          if (err instanceof ApiError) {
            this.send(client, "command.result", {
              operationId,
              status: err.status,
              error: err.toBody(),
            });
          } else {
            this.send(client, "command.result", {
              operationId,
              status: 500,
              error: { code: "INTERNAL", message: err instanceof Error ? err.message : "Unknown error." },
            });
          }
        }
        return;
      }
      default:
        this.send(client, "error", { message: `Unknown message type: ${msg.type}` });
    }
  }
}
