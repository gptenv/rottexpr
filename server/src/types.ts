// SPDX-License-Identifier: MIT
// Shared types for the ROTT sidecar server. These mirror the OpenAPI spec
// (docs/openapi.yaml), which is the source of truth. Nothing here touches
// the game engine: all state is observable state (screen, HUD, save files).

export type GameStatus =
  | "offline"
  | "menu"
  | "playing"
  | "paused"
  | "demo"
  | "loading";

export type Difficulty = "easy" | "normal" | "hard" | "very-hard";

export interface SaveSlot {
  slot: number;
  label: string | null;
  levelName: string | null;
  savedAt: string | null;
  exists: boolean;
}

export interface ObservableState {
  status: GameStatus;
  bridgeConnected: boolean;
  episode: number | null;
  level: number | null;
  levelName: string | null;
  difficulty: Difficulty | null;
  health: number | null;
  armor: number | null;
  ammo: Record<string, number> | null;
  weapons: string[] | null;
  score: number | null;
  lives: number | null;
  screenHash: string | null;
  screenCapturedAt: string | null;
  hudText: string | null;
  saveSlots: SaveSlot[];
  updatedAt: string;
}

export function emptyState(): ObservableState {
  return {
    status: "offline",
    bridgeConnected: false,
    episode: null,
    level: null,
    levelName: null,
    difficulty: null,
    health: null,
    armor: null,
    ammo: null,
    weapons: null,
    score: null,
    lives: null,
    screenHash: null,
    screenCapturedAt: null,
    hudText: null,
    saveSlots: [],
    updatedAt: new Date().toISOString(),
  };
}

export interface KeyInput {
  key: string;
  code?: string;
  action?: "down" | "up" | "press";
  holdMs?: number;
}

export interface MouseInput {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  action: "down" | "up" | "click" | "move";
}

export interface TextInput {
  text: string;
}

export interface InputEvent {
  key?: KeyInput;
  mouse?: MouseInput;
  text?: TextInput;
  delayMs?: number;
}

export interface InputSequence {
  events: InputEvent[];
}

export interface VideoConfig {
  resolution?: "320x200" | "640x400" | "800x600" | "1024x768" | "fullscreen";
  fullscreen?: boolean;
  brightness?: number;
  gamma?: number;
}

export interface AudioConfig {
  musicVolume?: number;
  sfxVolume?: number;
  musicEnabled?: boolean;
  sfxEnabled?: boolean;
}

export interface ControlsConfig {
  forward?: string;
  back?: string;
  strafeLeft?: string;
  strafeRight?: string;
  turnLeft?: string;
  turnRight?: string;
  fire?: string;
  use?: string;
  run?: string;
}

export interface GameOptions {
  crosshair?: boolean;
  autoRun?: boolean;
  mouseLook?: boolean;
  showMessages?: boolean;
  hudScale?: "small" | "normal" | "large";
}

export interface Config {
  video?: VideoConfig;
  audio?: AudioConfig;
  controls?: ControlsConfig;
  difficulty?: Difficulty;
  options?: GameOptions;
}

export interface SaveRequest {
  slot: number;
  label?: string;
}

export interface LoadRequest {
  slot: number;
}

export interface DemoRequest {
  demo: "DEMO1_3" | "DEMO2_3" | "DEMO3_3" | "DEMO4_3";
  loop?: boolean;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled?: boolean;
  weapons?: Record<string, Record<string, unknown>>;
  enemies?: Record<string, Record<string, unknown>>;
  levels?: Record<string, Record<string, unknown>>;
  wadOverlays?: string[];
}

export interface Mod extends ModManifest {
  loadedAt: string | null;
  status: "loaded" | "unloaded" | "error";
  error: string | null;
}

export interface Script {
  name: string;
  code: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface WasmSwapRequest {
  moduleUrl: string;
  saveSlot?: number;
}

export interface NewGameRequest {
  episode?: number;
  level?: number;
  difficulty?: Difficulty;
}

export interface GameInfo {
  title: string;
  version: string | null;
  dataSet: "shareware" | "registered" | "unknown";
  episodes: { episode: number; name: string; levels: number }[];
  demosAvailable: string[];
  bridgeVersion: string;
  wasmModuleUrl: string | null;
}

export interface MultiplayerHostRequest {
  mode?: "comm-bat" | "cooperative";
  maxPlayers?: number;
  episode?: number;
  level?: number;
}

export interface MultiplayerJoinRequest {
  address: string;
  playerName?: string;
}

export interface ChatMessage {
  from: string;
  text: string;
  to?: string | null;
  ts?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  detail?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = { code: this.code, message: this.message };
    if (this.detail !== undefined) body.detail = this.detail;
    return body;
  }
}

export function bridgeOffline(): ApiError {
  return new ApiError(
    503,
    "BRIDGE_OFFLINE",
    "No bridge connected: no game page is currently attached to the sidecar.",
  );
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "BAD_REQUEST", message);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

// ---- Bridge control-channel protocol (sidecar <-> page bridge, /bridge) ----
// The bridge is a separate MIT program in the page. The sidecar sends
// requests {id, method, params}; the bridge replies {id, ok, result} or
// {id, ok:false, error}. The bridge may also push unsolicited events
// {type:"event", event, payload}.

export type BridgeMethod =
  | "input.key"
  | "input.mouse"
  | "input.text"
  | "input.sequence"
  | "state.observe"
  | "screen.capture"
  | "config.apply"
  | "config.read"
  | "save.quick"
  | "save.load"
  | "save.list"
  | "demo.play"
  | "demo.stop"
  | "mod.apply"
  | "mod.remove"
  | "script.register"
  | "script.unregister"
  | "script.reload"
  | "wasm.swap"
  | "game.new"
  | "game.pause"
  | "game.resume"
  | "game.quit"
  | "game.info"
  | "multiplayer.host"
  | "multiplayer.join"
  | "multiplayer.leave"
  | "chat.type";

export interface BridgeRequest {
  id: number;
  method: BridgeMethod;
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface BridgeEvent {
  type: "event";
  event: string;
  payload?: unknown;
}

// ---- WebSocket broadcast protocol (sidecar <-> API clients, /ws) ----
// Every message is JSON: {type, seq, ts, payload}.

export type WsChannel = "game.state" | "game.events" | "game.deltas" | "game.chat";

export const WS_CHANNELS: WsChannel[] = [
  "game.state",
  "game.events",
  "game.deltas",
  "game.chat",
];

export interface WsMessage {
  type: string;
  seq: number;
  ts: string;
  payload: unknown;
}

export interface StateDelta {
  /** Top-level ObservableState keys that changed, with their new values. */
  changed: Partial<ObservableState>;
  /** Keys whose value became null / was removed. */
  removed: string[];
  screenHash: string | null;
}
