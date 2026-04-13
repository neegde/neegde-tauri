const LS_KEY = "neegde.recentHistory.v1";
const MAX = 20;

export function loadRecentHistory() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Adds or bumps a torrent to the front of the recent history.
 * @param {{ id: string, name: string, source: string, magnet?: string, cover?: string|null, artist?: string }} entry
 * @returns {Array} updated history
 */
export function addToRecentHistory(entry) {
  let history = loadRecentHistory();
  history = history.filter((h) => h.id !== entry.id);
  history.unshift({ ...entry, openedAt: Date.now() });
  history = history.slice(0, MAX);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch {}
  return history;
}
