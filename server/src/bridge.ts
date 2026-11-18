// SPDX-License-Identifier: MIT
// Bridge connection: the sidecar's link to the page-side bridge over the
// /bridge WebSocket control channel. One game page at a time; if a second
// page connects, it replaces the first (the sidecar logs the swap).
// Every call is a JSON request {id, method, params} with a correlated
// reply {id, ok, result|error} and a timeout. The bridge is a separate MIT
// program; this side never reads WASM memory or engine internals.

import type WebSocket from "ws";
import {
  ApiError,
  bridgeOffline,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeRequest,
  type BridgeResponse,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface BridgeHello {
  bridgeVersion: string;
  canvasWidth: number | null;
  canvasHeight: number | null;
  wasmModuleUrl: string | null;
  pageUrl: string | null;
}

export class BridgeConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private hello: BridgeHello | null = null;
  private onEvent: (event: BridgeEvent) => void = () => undefined;
  private onDisconnect: () => void = () => undefined;
  private onConnect: (hello: BridgeHello | null) => void = () => undefined;

  setEventHandler(fn: (event: BridgeEvent) => void): void {
    this.onEvent = fn;
  }

  setDisconnectHandler(fn: () => void): void {
    this.onDisconnect = fn;
  }

  setConnectHandler(fn: (hello: BridgeHello | null) => void): void {
    this.onConnect = fn;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === 1; // OPEN
  }

  getHello(): BridgeHello | null {
    return this.hello;
  }

  attach(ws: WebSocket): void {
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "replaced by a newer bridge connection");
      } catch {
        // ignore: the old socket may already be dead
      }
      this.failPending(new Error("Bridge connection replaced by a newer page."));
    }
    this.ws = ws;
    this.hello = null;
    ws.on("message", (raw: Buffer) => this.handleMessage(raw));
    ws.on("close", () => {
      if (this.ws === ws) {
        this.ws = null;
        this.hello = null;
        this.failPending(new Error("Bridge disconnected."));
        this.onDisconnect();
      }
    });
    ws.on("error", () => {
      // 'close' follows; nothing to do here.
    });
  }

  private handleMessage(raw: Buffer): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString("utf-8"));
    } catch {
      return; // ignore malformed frames
    }
    if (typeof msg !== "object" || msg === null) return;
    const obj = msg as Record<string, unknown>;
    if (obj.type === "event") {
      const event = obj as unknown as BridgeEvent;
      if (event.event === "bridge.hello" && typeof event.payload === "object" && event.payload !== null) {
        this.hello = event.payload as BridgeHello;
        this.onConnect(this.hello);
      }
      this.onEvent(event);
      return;
    }
    if (typeof obj.id === "number" && "ok" in obj) {
      const res = obj as unknown as BridgeResponse;
      const entry = this.pending.get(res.id);
      if (!entry) return;
      this.pending.delete(res.id);
      clearTimeout(entry.timer);
      if (res.ok) entry.resolve(res.result ?? null);
      else entry.reject(new Error(typeof res.error === "string" ? res.error : "Bridge call failed."));
    }
  }

  private failPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** Call a bridge method. Throws ApiError(503) when no bridge is attached. */
  async call<T = unknown>(
    method: BridgeMethod,
    params?: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.connected || this.ws === null) throw bridgeOffline();
    const id = this.nextId++;
    const req: BridgeRequest = { id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge call ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => resolve(v as T),
        reject,
        timer,
      });
    });
    this.ws.send(JSON.stringify(req));
    try {
      return await promise;
    } catch (err) {
      if (err instanceof Error && err.message.includes("timed out")) {
        throw new ApiError(503, "BRIDGE_TIMEOUT", err.message, `method=${method}`);
      }
      throw err;
    }
  }

  // Convenience wrappers (one per bridge method; handlers use these).

  inputKey(input: Record<string, unknown>): Promise<unknown> {
    return this.call("input.key", { input });
  }

  inputMouse(input: Record<string, unknown>): Promise<unknown> {
    return this.call("input.mouse", { input });
  }

  inputText(text: string): Promise<unknown> {
    return this.call("input.text", { text });
  }

  inputSequence(events: unknown[]): Promise<unknown> {
    return this.call("input.sequence", { events });
  }

  observe(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("state.observe", {});
  }

  captureScreen(): Promise<{ pngBase64: string; hash: string }> {
    return this.call<{ pngBase64: string; hash: string }>("screen.capture", {}, 15_000);
  }

  applyConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("config.apply", { config }, 15_000);
  }

  readConfig(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("config.read", {});
  }

  saveQuick(slot: number, label?: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("save.quick", { slot, label }, 20_000);
  }

  loadSave(slot: number): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("save.load", { slot }, 20_000);
  }

  listSaves(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("save.list", {});
  }

  playDemo(demo: string, loop: boolean): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("demo.play", { demo, loop });
  }

  stopDemo(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("demo.stop", {});
  }

  applyMod(mod: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("mod.apply", { mod }, 20_000);
  }

  removeMod(id: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("mod.remove", { id }, 20_000);
  }

  registerScript(name: string, code: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("script.register", { name, code }, 15_000);
  }

  unregisterScript(name: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("script.unregister", { name });
  }

  reloadScript(name: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("script.reload", { name }, 15_000);
  }

  swapWasm(moduleUrl: string, saveSlot: number): Promise<Record<string, unknown>> {
    // The page reloads as part of the swap; give the save step room.
    return this.call<Record<string, unknown>>("wasm.swap", { moduleUrl, saveSlot }, 30_000);
  }

  gameNew(episode: number, level: number, difficulty: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("game.new", { episode, level, difficulty }, 20_000);
  }

  gamePause(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("game.pause", {});
  }

  gameResume(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("game.resume", {});
  }

  gameQuit(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("game.quit", {}, 15_000);
  }

  gameInfo(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("game.info", {});
  }

  multiplayerHost(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("multiplayer.host", req, 20_000);
  }

  multiplayerJoin(address: string, playerName?: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>(
      "multiplayer.join",
      { address, playerName },
      20_000,
    );
  }

  multiplayerLeave(): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("multiplayer.leave", {}, 15_000);
  }

  chatType(text: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("chat.type", { text });
  }
}
