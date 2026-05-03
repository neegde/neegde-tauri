import { BoundedHistory } from "./BoundedHistory.js";

export interface RecentHistoryEntry {
  id: string;
  name: string;
  source: string;
  magnet?: string;
  cover?: string | null;
  artist?: string;
  openedAt?: number;
  [extra: string]: unknown;
}

const store = new BoundedHistory<RecentHistoryEntry>({
  storageKey: "neegde.recentHistory.v1",
  max: 20,
  keyOf: (e) => e.id,
  stamp: (e) => ({ ...e, openedAt: Date.now() }),
  isValid: (v): v is RecentHistoryEntry =>
    v != null && typeof v === "object" && typeof (v as { id?: unknown }).id === "string",
});

export function loadRecentHistory(): RecentHistoryEntry[] {
  return store.load();
}

/** Adds or bumps a torrent to the front of the recent history. */
export function addToRecentHistory(entry: RecentHistoryEntry): RecentHistoryEntry[] {
  return store.add(entry);
}

/** Removes one entry from recent history by id. */
export function removeFromRecentHistory(id: string): RecentHistoryEntry[] {
  return store.remove(id);
}
