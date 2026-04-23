const LS_KEY = "neegde.recentHistory.v1";
const MAX = 20;

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

export function loadRecentHistory(): RecentHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** Adds or bumps a torrent to the front of the recent history. */
export function addToRecentHistory(entry: RecentHistoryEntry): RecentHistoryEntry[] {
  let history = loadRecentHistory();
  history = history.filter((h) => h.id !== entry.id);
  history.unshift({ ...entry, openedAt: Date.now() });
  history = history.slice(0, MAX);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch { /* quota / disabled — ignore */ }
  return history;
}

/** Removes one entry from recent history by id. */
export function removeFromRecentHistory(id: string): RecentHistoryEntry[] {
  const history = loadRecentHistory().filter((h) => h.id !== id);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch { /* ignore */ }
  return history;
}
