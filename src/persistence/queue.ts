/**
 * Persisted playback queue — the Player's session across app restarts.
 *
 * Stores only ids + position. Track data resolved from `trackCache`.
 */

export const QUEUE_STORAGE_KEY = "neegde.queue.v2";

export interface QueueSnapshot {
  trackIds: string[];
  pos: number;
}

export function loadQueueSnapshot(): QueueSnapshot {
  const empty: QueueSnapshot = { trackIds: [], pos: 0 };
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<QueueSnapshot>;
    const trackIds = Array.isArray(p.trackIds) ? p.trackIds.filter((x) => typeof x === "string") : [];
    const pos = Number.isFinite(p.pos) ? Math.max(0, Math.min(Number(p.pos), trackIds.length - 1)) : 0;
    return { trackIds, pos: trackIds.length ? pos : 0 };
  } catch {
    return empty;
  }
}

export function saveQueueSnapshot(s: QueueSnapshot): void {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function clearQueueSnapshot(): void {
  try { localStorage.removeItem(QUEUE_STORAGE_KEY); } catch { /* ignore */ }
}
