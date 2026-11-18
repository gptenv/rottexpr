// SPDX-License-Identifier: MIT
// Game configuration store. The sidecar keeps the desired config and hands
// it to the bridge, which applies it through the game's own config file
// and/or in-game menus. Some video options only take effect when the WASM
// module is (re)loaded; those are reported as pendingReload, never applied
// by restarting the game behind the caller's back.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { badRequest, type Config } from "./types.js";

export const CONFIG_SECTIONS = ["video", "audio", "controls", "difficulty", "options"] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

const RELOAD_SECTIONS = new Set(["video"]); // resolution/fullscreen need a module (re)load

export function defaultConfig(): Config {
  return {
    video: { resolution: "640x400", fullscreen: false, brightness: 5, gamma: 5 },
    audio: { musicVolume: 80, sfxVolume: 80, musicEnabled: true, sfxEnabled: true },
    controls: {
      forward: "ArrowUp",
      back: "ArrowDown",
      strafeLeft: ",",
      strafeRight: ".",
      turnLeft: "ArrowLeft",
      turnRight: "ArrowRight",
      fire: "Control",
      use: " ",
      run: "Shift",
    },
    difficulty: "normal",
    options: {
      crosshair: true,
      autoRun: false,
      mouseLook: false,
      showMessages: true,
      hudScale: "normal",
    },
  };
}

function dataFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> ../../data/config.json when compiled to dist/, ../data when run from src via tsx.
  return join(here, "..", "data", "config.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateConfig(input: unknown): Config {
  if (!isRecord(input)) throw badRequest("Config body must be a JSON object.");
  const out: Config = {};
  if (input.video !== undefined) {
    if (!isRecord(input.video)) throw badRequest("video must be an object.");
    const v = input.video;
    if (v.resolution !== undefined && !["320x200", "640x400", "800x600", "1024x768", "fullscreen"].includes(String(v.resolution))) {
      throw badRequest(`Unknown resolution: ${String(v.resolution)}.`);
    }
    if (v.brightness !== undefined && (typeof v.brightness !== "number" || v.brightness < 0 || v.brightness > 10)) {
      throw badRequest("brightness must be an integer 0-10.");
    }
    if (v.gamma !== undefined && (typeof v.gamma !== "number" || v.gamma < 0 || v.gamma > 10)) {
      throw badRequest("gamma must be an integer 0-10.");
    }
    out.video = v as Config["video"];
  }
  if (input.audio !== undefined) {
    if (!isRecord(input.audio)) throw badRequest("audio must be an object.");
    for (const key of ["musicVolume", "sfxVolume"]) {
      const n = input.audio[key];
      if (n !== undefined && (typeof n !== "number" || n < 0 || n > 100)) {
        throw badRequest(`${key} must be a number 0-100.`);
      }
    }
    out.audio = input.audio as Config["audio"];
  }
  if (input.controls !== undefined) {
    if (!isRecord(input.controls)) throw badRequest("controls must be an object.");
    for (const [k, val] of Object.entries(input.controls)) {
      if (typeof val !== "string" || val.length === 0) {
        throw badRequest(`controls.${k} must be a non-empty key name.`);
      }
    }
    out.controls = input.controls as Config["controls"];
  }
  if (input.difficulty !== undefined) {
    if (!["easy", "normal", "hard", "very-hard"].includes(String(input.difficulty))) {
      throw badRequest(`Unknown difficulty: ${String(input.difficulty)}.`);
    }
    out.difficulty = input.difficulty as Config["difficulty"];
  }
  if (input.options !== undefined) {
    if (!isRecord(input.options)) throw badRequest("options must be an object.");
    out.options = input.options as Config["options"];
  }
  return out;
}

export class ConfigStore {
  private config: Config = defaultConfig();
  private readonly file: string;

  constructor(dataDir?: string) {
    this.file = dataDir ? join(dataDir, "config.json") : dataFile();
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      this.config = { ...defaultConfig(), ...validateConfig(parsed) };
    } catch {
      // No saved config yet (or it is invalid): start from defaults.
    }
  }

  get(): Config {
    return structuredClone(this.config);
  }

  getSection(section: ConfigSection): unknown {
    return structuredClone(this.config[section] ?? null);
  }

  /**
   * Merge a partial config, persist it, and report which sections need a
   * module reload to take effect. Returns the merged config + pending list.
   */
  put(input: unknown): { config: Config; pendingReload: string[] } {
    const patch = validateConfig(input);
    const pendingReload: string[] = [];
    const next: Config = structuredClone(this.config);
    for (const [key, value] of Object.entries(patch)) {
      const section = key as keyof Config;
      if (section === "difficulty") {
        next.difficulty = value as Config["difficulty"];
      } else {
        next[section] = { ...(next[section] as Record<string, unknown>), ...(value as Record<string, unknown>) } as never;
      }
      if (RELOAD_SECTIONS.has(key)) pendingReload.push(key);
    }
    this.config = next;
    this.persist();
    return { config: this.get(), pendingReload };
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.config, null, 2) + "\n", "utf-8");
  }
}
