import { invoke } from "@tauri-apps/api/core";

/** Дефолт совпадает с прежним поведением приложения. */
export const DEFAULT_MIRROR = "https://rutracker.net";

/**
 * Известные веб-зеркала RuTracker (HTTPS, форум phpBB).
 * Порядок — порядок перебора при автовыборе.
 */
export const KNOWN_MIRRORS = [
  "https://rutracker.net",
  "https://rutracker.org",
  "https://rutracker.nl",
  "https://rutracker.cr",
  "https://maintracker.org",
  "https://rutracker.lib",
];

const STORAGE_KEY = "rt_mirror";
const MODE_KEY = "rt_mirror_mode";
const RESOLVED_KEY = "rt_resolved_mirror";

export const MIRROR_MODE_AUTO = "auto";
export const MIRROR_MODE_MANUAL = "manual";

/** @returns {typeof MIRROR_MODE_AUTO | typeof MIRROR_MODE_MANUAL} */
export function getMirrorMode() {
  return localStorage.getItem(MODE_KEY) || MIRROR_MODE_MANUAL;
}

/** @param {typeof MIRROR_MODE_AUTO | typeof MIRROR_MODE_MANUAL} mode */
export function setMirrorMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

/** Кэш выбранного зеркала в рамках сессии (режим auto). */
let resolvedMirrorCache = null;

/**
 * Текущий базовый URL зеркала для запросов к Rutracker.
 * В режиме auto подставляется последнее удачно подобранное зеркало.
 */
export function getMirror() {
  if (getMirrorMode() === MIRROR_MODE_AUTO) {
    return (
      resolvedMirrorCache ||
      localStorage.getItem(RESOLVED_KEY) ||
      DEFAULT_MIRROR
    );
  }
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_MIRROR;
}

/** Последнее сохранённое автоподобранное зеркало (для подписи в UI). */
export function getLastResolvedMirror() {
  return localStorage.getItem(RESOLVED_KEY);
}

/**
 * В режиме auto запрашивает у бэкенда первое доступное зеркало из списка.
 * При ошибке оставляет прежний кэш или DEFAULT_MIRROR.
 */
export async function resolveMirrorIfNeeded() {
  if (getMirrorMode() !== MIRROR_MODE_AUTO) {
    resolvedMirrorCache = null;
    return;
  }
  try {
    const picked = await invoke("rutracker_pick_mirror", {
      candidates: KNOWN_MIRRORS,
    });
    resolvedMirrorCache = picked;
    localStorage.setItem(RESOLVED_KEY, picked);
  } catch {
    resolvedMirrorCache =
      localStorage.getItem(RESOLVED_KEY) || DEFAULT_MIRROR;
  }
}

/** Принудительно переподобрать зеркало (кнопка в настройках). */
export async function probeMirrorsNow() {
  const picked = await invoke("rutracker_pick_mirror", {
    candidates: KNOWN_MIRRORS,
  });
  resolvedMirrorCache = picked;
  localStorage.setItem(RESOLVED_KEY, picked);
  return picked;
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

/** Removes custom mirror and режим auto; default manual + rutracker.net. */
export function resetMirror() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(RESOLVED_KEY);
  localStorage.setItem(MODE_KEY, MIRROR_MODE_MANUAL);
  resolvedMirrorCache = null;
}

/** True if non-default mirror settings (auto mode or custom manual URL). */
export function hasCustomMirror() {
  if (getMirrorMode() === MIRROR_MODE_AUTO) return true;
  const stored = localStorage.getItem(STORAGE_KEY);
  return !!stored && stored !== DEFAULT_MIRROR;
}
