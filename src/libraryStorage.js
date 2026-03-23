/** Persist «Мне нравится» (треки и альбомы) across app restarts. */

const STORAGE_KEY = "neegde.library.likes";

/**
 * @returns {Record<string, object>}
 */
export function loadLikes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    return {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, object>} likes
 */
export function saveLikes(likes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(likes));
  } catch (e) {
    console.warn("libraryStorage: save failed", e);
  }
}
