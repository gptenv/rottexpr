// SPDX-License-Identifier: MIT
// Observable-state store: the single source of truth for what the sidecar
// believes about the running game. State comes only from the bridge
// (screen, HUD, save files). Deltas are computed by comparing snapshots.

import {
  emptyState,
  type ChatMessage,
  type ObservableState,
  type SaveSlot,
  type StateDelta,
} from "./types.js";

function slotKey(slot: SaveSlot): string {
  return `${slot.slot}:${slot.exists}:${slot.label ?? ""}:${slot.levelName ?? ""}:${slot.savedAt ?? ""}`;
}

function statesEqual(a: ObservableState, b: ObservableState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Flat diff of two observable states (top-level keys only). */
export function diffState(prev: ObservableState, next: ObservableState): StateDelta | null {
  if (statesEqual(prev, next)) return null;
  const changed: Partial<ObservableState> = {};
  const removed: string[] = [];
  const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const k = key as keyof ObservableState;
    const a = JSON.stringify(prev[k]);
    const b = JSON.stringify(next[k]);
    if (a !== b) {
      if (next[k] === null || next[k] === undefined) {
        removed.push(key);
      } else {
        (changed as Record<string, unknown>)[key] = next[k];
      }
    }
  }
  return { changed, removed, screenHash: next.screenHash };
}

export class GameStateStore {
  private state: ObservableState = emptyState();
  private screenPng: Buffer | null = null;
  private screenHashValue: string | null = null;
  private chat: ChatMessage[] = [];
  private seq = 0;
  private readonly startedAt = Date.now();

  get uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  getState(): ObservableState {
    return structuredClone(this.state);
  }

  getScreen(): { png: Buffer | null; hash: string | null } {
    return { png: this.screenPng, hash: this.screenHashValue };
  }

  /** Merge a partial observation from the bridge into the stored state. */
  applyObservation(patch: Partial<ObservableState>): StateDelta | null {
    const prev = this.state;
    const next: ObservableState = {
      ...prev,
      ...patch,
      bridgeConnected: true,
      updatedAt: new Date().toISOString(),
    };
    // Save slots only change when the bridge reports them; keep the merge simple.
    if (patch.saveSlots !== undefined) {
      const same =
        prev.saveSlots.map(slotKey).join("|") === patch.saveSlots.map(slotKey).join("|");
      if (same) next.saveSlots = prev.saveSlots;
    }
    this.state = next;
    return diffState(prev, next);
  }

  setBridgeConnected(connected: boolean): StateDelta | null {
    if (this.state.bridgeConnected === connected && !connected) return null;
    const prev = this.state;
    this.state = {
      ...prev,
      bridgeConnected: connected,
      status: connected ? prev.status : "offline",
      updatedAt: new Date().toISOString(),
    };
    return diffState(prev, this.state);
  }

  setScreen(png: Buffer, hash: string): void {
    this.screenPng = png;
    this.screenHashValue = hash;
    if (this.state.screenHash !== hash) {
      this.state = {
        ...this.state,
        screenHash: hash,
        screenCapturedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  addChat(message: ChatMessage): ChatMessage {
    const full: ChatMessage = {
      from: message.from,
      text: message.text,
      to: message.to ?? null,
      ts: message.ts ?? new Date().toISOString(),
    };
    this.chat.push(full);
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    return full;
  }

  getChat(): ChatMessage[] {
    return structuredClone(this.chat);
  }
}
