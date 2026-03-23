export const DEFAULT_MIRROR = "https://rutracker.net";

const STORAGE_KEY = "rt_mirror";

/** Returns the current mirror URL (or the default if not set). */
export function getMirror() {
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_MIRROR;
}

/** Persists a new mirror URL. Pass empty string to reset to default. */
export function setMirror(url) {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed) {
    localStorage.setItem(STORAGE_KEY, trimmed);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Removes the custom mirror so the default is used again. */
export function resetMirror() {
  localStorage.removeItem(STORAGE_KEY);
}

/** True if the user has overridden the default mirror. */
export function hasCustomMirror() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return !!stored && stored !== DEFAULT_MIRROR;
}
