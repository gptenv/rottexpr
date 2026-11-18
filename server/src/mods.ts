// SPDX-License-Identifier: MIT
// Data-driven mod registry. A mod is JSON values (weapons/enemies/levels)
// plus optional WAD overlay filenames. Mods never contain code and never
// touch the engine. Applying a mod means: the bridge writes the overlay
// files into the game's data directory and applies the JSON overrides
// through the script layer. Values the engine only reads at load time take
// effect on the next level load — the registry reports that honestly via
// the mod status, it never claims an instant engine change.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { badRequest, notFound, type Mod, type ModManifest } from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function validateModManifest(input: unknown): ModManifest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw badRequest("Mod body must be a JSON object.");
  }
  const m = input as Record<string, unknown>;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    throw badRequest("Mod id must match ^[a-z0-9][a-z0-9_-]*$.");
  }
  if (typeof m.name !== "string" || m.name.length === 0) {
    throw badRequest("Mod name is required.");
  }
  if (typeof m.version !== "string" || m.version.length === 0) {
    throw badRequest("Mod version is required.");
  }
  if (m.wadOverlays !== undefined) {
    if (!Array.isArray(m.wadOverlays) || m.wadOverlays.some((f) => typeof f !== "string")) {
      throw badRequest("wadOverlays must be an array of filenames.");
    }
    for (const f of m.wadOverlays as string[]) {
      if (f.includes("/") || f.includes("\\") || f.includes("..")) {
        throw badRequest(`WAD overlay filename must be a bare filename: ${f}`);
      }
    }
  }
  return m as unknown as ModManifest;
}

export class ModRegistry {
  private mods = new Map<string, Mod>();
  private readonly file: string;

  constructor(dataDir?: string) {
    const here = dirname(fileURLToPath(import.meta.url));
    this.file = dataDir ? join(dataDir, "mods.json") : join(here, "..", "data", "mods.json");
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed as Mod[]) {
          if (typeof item.id === "string") this.mods.set(item.id, item);
        }
      }
    } catch {
      // No saved registry yet.
    }
  }

  list(): Mod[] {
    return [...this.mods.values()].map((m) => structuredClone(m));
  }

  get(id: string): Mod {
    const mod = this.mods.get(id);
    if (!mod) throw notFound(`Unknown mod id: ${id}`);
    return structuredClone(mod);
  }

  has(id: string): boolean {
    return this.mods.has(id);
  }

  /**
   * Read one WAD overlay file for a mod from data/mods/<id>/<filename>.
   * Operators place overlay files there; returns null when absent.
   */
  readOverlayBytes(id: string, filename: string): Buffer | null {
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
    const path = join(dirname(this.file), "mods", id, filename);
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  }

  /** Record a mod as loaded (after the bridge applied it). */
  markLoaded(manifest: ModManifest): Mod {
    const mod: Mod = {
      ...manifest,
      enabled: manifest.enabled ?? true,
      loadedAt: new Date().toISOString(),
      status: "loaded",
      error: null,
    };
    this.mods.set(mod.id, mod);
    this.persist();
    return structuredClone(mod);
  }

  markError(manifest: ModManifest, error: string): Mod {
    const mod: Mod = {
      ...manifest,
      enabled: manifest.enabled ?? true,
      loadedAt: null,
      status: "error",
      error,
    };
    this.mods.set(mod.id, mod);
    this.persist();
    return structuredClone(mod);
  }

  markUnloaded(id: string): Mod {
    const mod = this.get(id);
    mod.status = "unloaded";
    mod.loadedAt = null;
    mod.error = null;
    this.mods.set(id, mod);
    this.persist();
    return structuredClone(mod);
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.mods.values()], null, 2) + "\n", "utf-8");
  }
}
