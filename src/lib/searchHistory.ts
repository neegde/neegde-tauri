const LS_KEY = "neegde.searchHistory.v1";
const MAX = 15;

export function loadSearchHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function addToSearchHistory(query: string): string[] {
  if (!query?.trim()) return loadSearchHistory();
  const q = query.trim();
  let history = loadSearchHistory();
  history = history.filter((h) => h !== q);
  history.unshift(q);
  history = history.slice(0, MAX);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch { /* ignore */ }
  return history;
}

/** Removes one query string from saved search history. */
export function removeFromSearchHistory(query: string): string[] {
  const history = loadSearchHistory().filter((h) => h !== query);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch { /* ignore */ }
  return history;
}
