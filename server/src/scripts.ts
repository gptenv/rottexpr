// SPDX-License-Identifier: MIT
// Script-layer registry. Scripts are plain JS that runs in the page's JS
// context, OUTSIDE the WASM module, and drives the game only through the
// bridge API (window.RottBridge). Registering a script sends its source to
// the bridge for evaluation; reloading re-evaluates the stored source in
// place. The game is never restarted by the script layer.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { badRequest, notFound, type Script } from "./types.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_CODE_BYTES = 1_000_000;

export function validateScript(input: unknown): Script {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw badRequest("Script body must be a JSON object.");
  }
  const s = input as Record<string, unknown>;
  if (typeof s.name !== "string" || !NAME_RE.test(s.name)) {
    throw badRequest("Script name must match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$.");
  }
  if (typeof s.code !== "string" || s.code.trim().length === 0) {
    throw badRequest("Script code must be a non-empty string.");
  }
  if (Buffer.byteLength(s.code, "utf-8") > MAX_CODE_BYTES) {
    throw badRequest("Script code exceeds the 1 MiB limit.");
  }
  return {
    name: s.name,
    code: s.code,
    enabled: s.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
}

export class ScriptRegistry {
  private scripts = new Map<string, Script>();
  private readonly file: string;

  constructor(dataDir?: string) {
    const here = dirname(fileURLToPath(import.meta.url));
    this.file = dataDir ? join(dataDir, "scripts.json") : join(here, "..", "data", "scripts.json");
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed as Script[]) {
          if (typeof item.name === "string") this.scripts.set(item.name, item);
        }
      }
    } catch {
      // No saved registry yet.
    }
  }

  list(): Script[] {
    return [...this.scripts.values()].map((s) => structuredClone(s));
  }

  get(name: string): Script {
    const script = this.scripts.get(name);
    if (!script) throw notFound(`Unknown script: ${name}`);
    return structuredClone(script);
  }

  has(name: string): boolean {
    return this.scripts.has(name);
  }

  put(script: Script): Script {
    const stored: Script = { ...script, updatedAt: new Date().toISOString() };
    this.scripts.set(stored.name, stored);
    this.persist();
    return structuredClone(stored);
  }

  remove(name: string): Script {
    const script = this.get(name);
    this.scripts.delete(name);
    this.persist();
    return script;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.scripts.values()], null, 2) + "\n", "utf-8");
  }
}
