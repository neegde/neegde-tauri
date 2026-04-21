const LS_KEY = "neegde.searchHistory.v1";
const MAX = 15;

export function loadSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function addToSearchHistory(query) {
  if (!query?.trim()) return loadSearchHistory();
  const q = query.trim();
  let history = loadSearchHistory();
  history = history.filter((h) => h !== q);
  history.unshift(q);
  history = history.slice(0, MAX);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch {}
  return history;
}

/**
 * Removes one query string from saved search history.
 *
 * @param {string} query
 * @returns {string[]} updated history
 */
export function removeFromSearchHistory(query) {
  let history = loadSearchHistory().filter((h) => h !== query);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(history));
  } catch {}
  return history;
}
