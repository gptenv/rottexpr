// SPDX-License-Identifier: MIT
// REST handlers: one method per OpenAPI operationId. The WebSocket layer
// (ws.ts) dispatches commands to these SAME methods — same handler
// functions, different transport. Every method returns {status, body}
// (body may be a Buffer for the PNG screenshot). Nothing here touches the
// engine: all game effects go through the bridge.

import type { BridgeConnection } from "./bridge.js";
import { CONFIG_SECTIONS, type ConfigStore } from "./config.js";
import { validateModManifest, type ModRegistry } from "./mods.js";
import { validateScript, type ScriptRegistry } from "./scripts.js";
import type { GameStateStore } from "./state.js";
import {
  ApiError,
  badRequest,
  bridgeOffline,
  notFound,
  type ChatMessage,
  type Config,
  type GameInfo,
  type KeyInput,
  type MouseInput,
  type ObservableState,
} from "./types.js";

export interface HandlerResult {
  status: number;
  body: unknown;
  contentType?: string;
}

export interface HandlerEvents {
  /** Called when a chat message is recorded (WS game.chat broadcast). */
  onChat: (message: ChatMessage) => void;
  /** Called for notable game events (WS game.events broadcast). */
  onGameEvent: (kind: string, payload: unknown) => void;
}

function ok(body: unknown, status = 200): HandlerResult {
  return { status, body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireSlot(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 9) {
    throw badRequest("slot must be an integer 0-9.");
  }
  return v;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw badRequest(`${field} is required.`);
  return v;
}

/** Pick the known observable-state keys out of a bridge observation. */
function toObservation(result: unknown): Partial<ObservableState> {
  if (!isRecord(result)) return {};
  const out: Partial<ObservableState> = {};
  const state = isRecord(result.state) ? result.state : result;
  const keys = [
    "status", "episode", "level", "levelName", "difficulty", "health",
    "armor", "ammo", "weapons", "score", "lives", "screenHash",
    "screenCapturedAt", "hudText", "saveSlots",
  ] as const;
  for (const key of keys) {
    if (key in state) (out as Record<string, unknown>)[key] = state[key];
  }
  return out;
}

const EPISODES = [
  { episode: 1, name: "The HUNT Begins", levels: 11 },
  { episode: 2, name: "Mystical Mission", levels: 11 },
  { episode: 3, name: "The Dark War", levels: 11 },
];

export class Handlers {
  constructor(
    private readonly bridge: BridgeConnection,
    private readonly store: GameStateStore,
    private readonly configStore: ConfigStore,
    private readonly mods: ModRegistry,
    private readonly scripts: ScriptRegistry,
    private readonly events: HandlerEvents,
    private readonly version: string,
  ) {}

  private requireBridge(): void {
    if (!this.bridge.connected) throw bridgeOffline();
  }

  /** Fresh observation from the bridge, merged into the store. */
  private async refreshState(): Promise<ObservableState> {
    try {
      const result = await this.bridge.observe();
      const patch = toObservation(result);
      this.store.applyObservation(patch);
    } catch {
      // Observation is best-effort; the stored state is still returned.
    }
    return this.store.getState();
  }

  // ---- Health / State ----

  getHealth(): HandlerResult {
    return ok({
      status: this.bridge.connected ? "ok" : "degraded",
      bridgeConnected: this.bridge.connected,
      uptimeSeconds: this.store.uptimeSeconds,
      version: this.version,
    });
  }

  getState(): HandlerResult {
    return ok(this.store.getState());
  }

  async getScreen(): Promise<HandlerResult> {
    this.requireBridge();
    const { pngBase64, hash } = await this.bridge.captureScreen();
    const png = Buffer.from(pngBase64, "base64");
    this.store.setScreen(png, hash);
    return { status: 200, body: png, contentType: "image/png" };
  }

  // ---- Input ----

  async sendKey(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Key input must be a JSON object.");
    const key = requireString(body.key, "key");
    const input: KeyInput = { key };
    if (body.code !== undefined) input.code = requireString(body.code, "code");
    if (body.action !== undefined) {
      if (!["down", "up", "press"].includes(String(body.action))) {
        throw badRequest("action must be down, up, or press.");
      }
      input.action = body.action as KeyInput["action"];
    }
    if (body.holdMs !== undefined) {
      if (typeof body.holdMs !== "number" || body.holdMs < 0 || body.holdMs > 5000) {
        throw badRequest("holdMs must be 0-5000.");
      }
      input.holdMs = body.holdMs;
    }
    this.requireBridge();
    await this.bridge.inputKey(input as unknown as Record<string, unknown>);
    return ok({ accepted: true, echoed: input });
  }

  async sendMouse(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Mouse input must be a JSON object.");
    const { x, y, action } = body;
    if (typeof x !== "number" || x < 0 || typeof y !== "number" || y < 0) {
      throw badRequest("x and y must be non-negative numbers (CSS pixels from the canvas origin).");
    }
    if (!["down", "up", "click", "move"].includes(String(action))) {
      throw badRequest("action must be down, up, click, or move.");
    }
    const input: MouseInput = {
      x, y,
      button: (typeof body.button === "string" ? body.button : "left") as MouseInput["button"],
      action: action as MouseInput["action"],
    };
    this.requireBridge();
    await this.bridge.inputMouse(input as unknown as Record<string, unknown>);
    return ok({ accepted: true });
  }

  async sendText(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Text input must be a JSON object.");
    const text = requireString(body.text, "text");
    this.requireBridge();
    await this.bridge.inputText(text);
    return ok({ accepted: true });
  }

  async sendInputSequence(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body) || !Array.isArray(body.events)) {
      throw badRequest("Input sequence must be an object with an events array.");
    }
    if (body.events.length < 1 || body.events.length > 500) {
      throw badRequest("events must contain 1-500 entries.");
    }
    for (const event of body.events as unknown[]) {
      if (!isRecord(event) || (!event.key && !event.mouse && !event.text)) {
        throw badRequest("Each sequence event needs exactly one of key, mouse, or text.");
      }
    }
    this.requireBridge();
    await this.bridge.inputSequence(body.events as unknown[]);
    return ok({ accepted: true, executed: body.events.length });
  }

  // ---- Config ----

  getConfig(): HandlerResult {
    return ok(this.configStore.get());
  }

  async putConfig(body: unknown): Promise<HandlerResult> {
    const { config, pendingReload } = this.configStore.put(body);
    let applied: Record<string, unknown> = {};
    if (this.bridge.connected) {
      try {
        applied = await this.bridge.applyConfig(config as unknown as Record<string, unknown>);
        if (Array.isArray(applied.pendingReload)) {
          for (const section of applied.pendingReload as string[]) {
            if (!pendingReload.includes(section)) pendingReload.push(section);
          }
        }
      } catch (err) {
        // Config is persisted server-side even if the bridge is unreachable;
        // the bridge picks it up when it (re)connects. Report honestly.
        if (err instanceof ApiError) throw err;
        pendingReload.push("bridge-apply-failed");
      }
    } else {
      pendingReload.push("bridge-offline");
    }
    return ok({ ...(config as unknown as Record<string, unknown>), pendingReload });
  }

  getConfigSection(params: Record<string, string>): HandlerResult {
    const section = params.section ?? "";
    if (!(CONFIG_SECTIONS as readonly string[]).includes(section)) {
      throw badRequest(`Unknown config section: ${section}.`);
    }
    const value = this.configStore.getSection(section as (typeof CONFIG_SECTIONS)[number]);
    return ok(value as unknown);
  }

  // ---- Saves ----

  async listSaves(): Promise<HandlerResult> {
    if (this.bridge.connected) {
      try {
        const result = await this.bridge.listSaves();
        if (isRecord(result) && Array.isArray(result.slots)) {
          const slots = result.slots as ObservableState["saveSlots"];
          this.store.applyObservation({ saveSlots: slots });
        }
      } catch {
        // Fall through to the stored slots.
      }
    }
    return ok(this.store.getState().saveSlots);
  }

  async saveGame(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Save request must be a JSON object.");
    const slot = requireSlot(body.slot);
    const label = body.label !== undefined ? requireString(body.label, "label") : undefined;
    this.requireBridge();
    const result = await this.bridge.saveQuick(slot, label);
    const slotInfo = isRecord(result) && isRecord(result.slot) ? result.slot : null;
    const saved = {
      slot,
      label: label ?? (slotInfo && typeof slotInfo.label === "string" ? slotInfo.label : null),
      levelName: slotInfo && typeof slotInfo.levelName === "string" ? slotInfo.levelName : null,
      savedAt: new Date().toISOString(),
      exists: true,
    };
    const slots = this.store.getState().saveSlots;
    const next = slots.filter((s) => s.slot !== slot);
    next.push(saved);
    this.store.applyObservation({ saveSlots: next });
    this.events.onGameEvent("game.saved", { slot, label: saved.label });
    return ok(saved);
  }

  async loadGame(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Load request must be a JSON object.");
    const slot = requireSlot(body.slot);
    const existing = this.store.getState().saveSlots.find((s) => s.slot === slot);
    if (existing && !existing.exists) throw notFound(`Save slot ${slot} is empty.`);
    this.requireBridge();
    await this.bridge.loadSave(slot);
    this.events.onGameEvent("game.loaded", { slot });
    return ok(await this.refreshState());
  }

  // ---- Demo ----

  async playDemo(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Demo request must be a JSON object.");
    const demo = String(body.demo ?? "");
    if (!["DEMO1_3", "DEMO2_3", "DEMO3_3", "DEMO4_3"].includes(demo)) {
      throw badRequest(`Unknown demo: ${demo}.`);
    }
    this.requireBridge();
    await this.bridge.playDemo(demo, body.loop === true);
    this.events.onGameEvent("demo.started", { demo });
    return ok(await this.refreshState());
  }

  async stopDemo(): Promise<HandlerResult> {
    this.requireBridge();
    await this.bridge.stopDemo();
    this.events.onGameEvent("demo.stopped", {});
    return ok(await this.refreshState());
  }

  // ---- Mods ----

  listMods(): HandlerResult {
    return ok(this.mods.list());
  }

  async loadMod(body: unknown): Promise<HandlerResult> {
    const manifest = validateModManifest(body);
    if (!this.bridge.connected) {
      // Record the manifest; the bridge applies it when it connects.
      const recorded = this.mods.markLoaded(manifest);
      return ok({ ...recorded, status: "loaded", error: "bridge-offline: applied on next bridge connect" });
    }
    try {
      const payload: Record<string, unknown> = { ...manifest };
      const overlayFiles: { name: string; base64: string }[] = [];
      for (const name of manifest.wadOverlays ?? []) {
        const bytes = this.mods.readOverlayBytes(manifest.id, name);
        if (bytes) overlayFiles.push({ name, base64: bytes.toString("base64") });
      }
      payload.overlayFiles = overlayFiles;
      await this.bridge.applyMod(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bridge failed to apply the mod.";
      return ok(this.mods.markError(manifest, message));
    }
    this.events.onGameEvent("mod.loaded", { id: manifest.id });
    return ok(this.mods.markLoaded(manifest));
  }

  getMod(params: Record<string, string>): HandlerResult {
    return ok(this.mods.get(params.id ?? ""));
  }

  async unloadMod(params: Record<string, string>): Promise<HandlerResult> {
    const id = params.id ?? "";
    this.mods.get(id); // throws 404 when unknown
    if (this.bridge.connected) {
      try {
        await this.bridge.removeMod(id);
      } catch {
        // Best-effort: the registry still records the unload.
      }
    }
    this.events.onGameEvent("mod.unloaded", { id });
    return ok(this.mods.markUnloaded(id));
  }

  async reloadMod(params: Record<string, string>): Promise<HandlerResult> {
    const id = params.id ?? "";
    const manifest = this.mods.get(id);
    if (!this.bridge.connected) throw bridgeOffline();
    try {
      const payload: Record<string, unknown> = { ...manifest };
      const overlayFiles: { name: string; base64: string }[] = [];
      for (const name of manifest.wadOverlays ?? []) {
        const bytes = this.mods.readOverlayBytes(manifest.id, name);
        if (bytes) overlayFiles.push({ name, base64: bytes.toString("base64") });
      }
      payload.overlayFiles = overlayFiles;
      await this.bridge.applyMod(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bridge failed to reload the mod.";
      return ok(this.mods.markError(manifest, message));
    }
    this.events.onGameEvent("mod.reloaded", { id });
    return ok(this.mods.markLoaded(manifest));
  }

  // ---- Scripts ----

  listScripts(): HandlerResult {
    return ok(this.scripts.list());
  }

  async registerScript(body: unknown): Promise<HandlerResult> {
    const script = validateScript(body);
    this.requireBridge();
    await this.bridge.registerScript(script.name, script.code);
    this.events.onGameEvent("script.registered", { name: script.name });
    return ok(this.scripts.put(script));
  }

  getScript(params: Record<string, string>): HandlerResult {
    return ok(this.scripts.get(params.name ?? ""));
  }

  async unregisterScript(params: Record<string, string>): Promise<HandlerResult> {
    const name = params.name ?? "";
    this.scripts.get(name); // throws 404 when unknown
    if (this.bridge.connected) {
      try {
        await this.bridge.unregisterScript(name);
      } catch {
        // Best-effort.
      }
    }
    this.events.onGameEvent("script.unregistered", { name });
    return ok(this.scripts.remove(name));
  }

  async reloadScript(params: Record<string, string>): Promise<HandlerResult> {
    const name = params.name ?? "";
    const script = this.scripts.get(name);
    this.requireBridge();
    await this.bridge.reloadScript(name);
    this.events.onGameEvent("script.reloaded", { name });
    return ok(this.scripts.put(script));
  }

  // ---- WASM swap ----

  async swapWasm(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Swap request must be a JSON object.");
    const moduleUrl = requireString(body.moduleUrl, "moduleUrl");
    let url: URL;
    try {
      url = new URL(moduleUrl);
    } catch {
      throw badRequest("moduleUrl must be a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw badRequest("moduleUrl must be http(s).");
    }
    const saveSlot = body.saveSlot !== undefined ? requireSlot(body.saveSlot) : 9;
    this.requireBridge();
    // Save first (the bridge saves, then reloads the page with the new module).
    await this.bridge.saveQuick(saveSlot, "wasm-swap");
    await this.bridge.swapWasm(moduleUrl, saveSlot);
    this.events.onGameEvent("wasm.swap", { moduleUrl, saveSlot });
    return ok({
      accepted: true,
      saveSlot,
      moduleUrl,
      note: "The game page reloads with the new module; the bridge re-loads the save on boot. State is preserved through the game's own save file.",
    });
  }

  // ---- Game ----

  async getGameInfo(): Promise<HandlerResult> {
    const hello = this.bridge.getHello();
    let bridgeInfo: Record<string, unknown> = {};
    if (this.bridge.connected) {
      try {
        bridgeInfo = await this.bridge.gameInfo();
      } catch {
        // Static info still applies.
      }
    }
    const info: GameInfo = {
      title: "Rise of the Triad",
      version: typeof bridgeInfo.version === "string" ? bridgeInfo.version : null,
      dataSet:
        bridgeInfo.dataSet === "shareware" || bridgeInfo.dataSet === "registered"
          ? bridgeInfo.dataSet
          : "unknown",
      episodes: EPISODES,
      demosAvailable: ["DEMO1_3", "DEMO2_3", "DEMO3_3", "DEMO4_3"],
      bridgeVersion: hello?.bridgeVersion ?? "none",
      wasmModuleUrl: hello?.wasmModuleUrl ?? null,
    };
    return ok(info);
  }

  async newGame(body: unknown): Promise<HandlerResult> {
    const req = isRecord(body) ? body : {};
    const episode = req.episode !== undefined ? Number(req.episode) : 1;
    const level = req.level !== undefined ? Number(req.level) : 1;
    const difficulty = typeof req.difficulty === "string" ? req.difficulty : "normal";
    if (![1, 2, 3].includes(episode)) throw badRequest("episode must be 1-3.");
    if (!Number.isInteger(level) || level < 1) throw badRequest("level must be an integer >= 1.");
    if (!["easy", "normal", "hard", "very-hard"].includes(difficulty)) {
      throw badRequest(`Unknown difficulty: ${difficulty}.`);
    }
    this.requireBridge();
    await this.bridge.gameNew(episode, level, difficulty);
    this.events.onGameEvent("game.new", { episode, level, difficulty });
    return ok(await this.refreshState());
  }

  async pauseGame(): Promise<HandlerResult> {
    this.requireBridge();
    await this.bridge.gamePause();
    return ok(await this.refreshState());
  }

  async resumeGame(): Promise<HandlerResult> {
    this.requireBridge();
    await this.bridge.gameResume();
    return ok(await this.refreshState());
  }

  async quitGame(): Promise<HandlerResult> {
    this.requireBridge();
    await this.bridge.gameQuit();
    this.events.onGameEvent("game.quit", {});
    return ok(await this.refreshState());
  }

  // ---- Multiplayer ----

  async hostMultiplayer(body: unknown): Promise<HandlerResult> {
    const req = isRecord(body) ? body : {};
    const mode = req.mode !== undefined ? String(req.mode) : "comm-bat";
    if (!["comm-bat", "cooperative"].includes(mode)) {
      throw badRequest(`Unknown multiplayer mode: ${mode}.`);
    }
    const maxPlayers = req.maxPlayers !== undefined ? Number(req.maxPlayers) : 4;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 11) {
      throw badRequest("maxPlayers must be an integer 2-11.");
    }
    this.requireBridge();
    await this.bridge.multiplayerHost({
      mode,
      maxPlayers,
      episode: req.episode !== undefined ? Number(req.episode) : 1,
      level: req.level !== undefined ? Number(req.level) : 1,
    });
    this.events.onGameEvent("multiplayer.hosted", { mode, maxPlayers });
    return ok(await this.refreshState());
  }

  async joinMultiplayer(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Join request must be a JSON object.");
    const address = requireString(body.address, "address");
    const playerName = body.playerName !== undefined ? requireString(body.playerName, "playerName") : undefined;
    this.requireBridge();
    await this.bridge.multiplayerJoin(address, playerName);
    this.events.onGameEvent("multiplayer.joined", { address });
    return ok(await this.refreshState());
  }

  async leaveMultiplayer(): Promise<HandlerResult> {
    this.requireBridge();
    await this.bridge.multiplayerLeave();
    this.events.onGameEvent("multiplayer.left", {});
    return ok(await this.refreshState());
  }

  // ---- Chat ----

  listChat(): HandlerResult {
    return ok(this.store.getChat());
  }

  async sendChat(body: unknown): Promise<HandlerResult> {
    if (!isRecord(body)) throw badRequest("Chat message must be a JSON object.");
    const from = requireString(body.from, "from");
    const text = requireString(body.text, "text");
    const to = body.to === undefined || body.to === null ? null : requireString(body.to, "to");
    const message = this.store.addChat({ from, text, to });
    this.events.onChat(message);
    // "game" as recipient means: type it into the game's own chat.
    if (to === "game" && this.bridge.connected) {
      try {
        await this.bridge.chatType(text);
      } catch {
        // Recorded + broadcast regardless; in-game delivery is best-effort.
      }
    }
    return ok(message);
  }

  // ---- Dispatch (used by the router and the WebSocket command channel) ----

  async dispatch(operationId: string, params: Record<string, string>, body: unknown): Promise<HandlerResult> {
    switch (operationId) {
      case "getHealth": return this.getHealth();
      case "getState": return this.getState();
      case "getScreen": return this.getScreen();
      case "sendKey": return this.sendKey(body);
      case "sendMouse": return this.sendMouse(body);
      case "sendText": return this.sendText(body);
      case "sendInputSequence": return this.sendInputSequence(body);
      case "getConfig": return this.getConfig();
      case "putConfig": return this.putConfig(body);
      case "getConfigSection": return this.getConfigSection(params);
      case "listSaves": return this.listSaves();
      case "saveGame": return this.saveGame(body);
      case "loadGame": return this.loadGame(body);
      case "playDemo": return this.playDemo(body);
      case "stopDemo": return this.stopDemo();
      case "listMods": return this.listMods();
      case "loadMod": return this.loadMod(body);
      case "getMod": return this.getMod(params);
      case "unloadMod": return this.unloadMod(params);
      case "reloadMod": return this.reloadMod(params);
      case "listScripts": return this.listScripts();
      case "registerScript": return this.registerScript(body);
      case "getScript": return this.getScript(params);
      case "unregisterScript": return this.unregisterScript(params);
      case "reloadScript": return this.reloadScript(params);
      case "swapWasm": return this.swapWasm(body);
      case "getGameInfo": return this.getGameInfo();
      case "newGame": return this.newGame(body);
      case "pauseGame": return this.pauseGame();
      case "resumeGame": return this.resumeGame();
      case "quitGame": return this.quitGame();
      case "hostMultiplayer": return this.hostMultiplayer(body);
      case "joinMultiplayer": return this.joinMultiplayer(body);
      case "leaveMultiplayer": return this.leaveMultiplayer();
      case "listChat": return this.listChat();
      case "sendChat": return this.sendChat(body);
      default: throw notFound(`Unknown operation: ${operationId}`);
    }
  }
}

export { type Config };
