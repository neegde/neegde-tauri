import { invoke } from "@tauri-apps/api/core";

/** Дефолт совпадает с прежним поведением приложения. */
export const DEFAULT_MIRROR = "https://rutracker.net";

/** Известные веб-зеркала RuTracker (HTTPS, форум phpBB). */
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

/** Upper bound for `rutracker_pick_mirror` (worst case is many 12s mirror probes in Rust). */
const MIRROR_PICK_BUDGET_MS = 35_000;

/**
 * Fails the promise if `p` has not settled within `ms` (safety net when Tauri invoke
 * or the backend is slow / wedged on bad networks).
 */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      reject(new Error("timeout"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export const MIRROR_MODE_AUTO = "auto";
export const MIRROR_MODE_MANUAL = "manual";

export type MirrorMode = typeof MIRROR_MODE_AUTO | typeof MIRROR_MODE_MANUAL;

export function getMirrorMode(): MirrorMode {
  const v = localStorage.getItem(MODE_KEY);
  return v === MIRROR_MODE_AUTO ? MIRROR_MODE_AUTO : MIRROR_MODE_MANUAL;
}

export function setMirrorMode(mode: MirrorMode): void {
  localStorage.setItem(MODE_KEY, mode);
}

/** Кэш выбранного зеркала в рамках сессии (режим auto). */
let resolvedMirrorCache: string | null = null;

/** Текущий базовый URL зеркала для запросов к Rutracker. */
export function getMirror(): string {
  if (getMirrorMode() === MIRROR_MODE_AUTO) {
    return (
      resolvedMirrorCache ||
      localStorage.getItem(RESOLVED_KEY) ||
      DEFAULT_MIRROR
    );
  }
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_MIRROR;
}

export function getLastResolvedMirror(): string | null {
  return localStorage.getItem(RESOLVED_KEY);
}

/** В режиме auto запрашивает у Tauri первое доступное зеркало из списка. */
export async function resolveMirrorIfNeeded(): Promise<void> {
  if (getMirrorMode() !== MIRROR_MODE_AUTO) {
    resolvedMirrorCache = null;
    return;
  }
  try {
    const picked = await withTimeout(
      invoke<string>("rutracker_pick_mirror", { candidates: KNOWN_MIRRORS }),
      MIRROR_PICK_BUDGET_MS
    );
    resolvedMirrorCache = picked;
    localStorage.setItem(RESOLVED_KEY, picked);
  } catch {
    resolvedMirrorCache =
      localStorage.getItem(RESOLVED_KEY) || DEFAULT_MIRROR;
  }
}

export async function probeMirrorsNow(): Promise<string> {
  const picked = await withTimeout(
    invoke<string>("rutracker_pick_mirror", { candidates: KNOWN_MIRRORS }),
    MIRROR_PICK_BUDGET_MS
  );
  resolvedMirrorCache = picked;
  localStorage.setItem(RESOLVED_KEY, picked);
  return picked;
}

/** Persists a new mirror URL. Pass empty string to reset to default. */
export function setMirror(url: string): void {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed) {
    localStorage.setItem(STORAGE_KEY, trimmed);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function resetMirror(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(RESOLVED_KEY);
  localStorage.setItem(MODE_KEY, MIRROR_MODE_MANUAL);
  resolvedMirrorCache = null;
}

export function hasCustomMirror(): boolean {
  if (getMirrorMode() === MIRROR_MODE_AUTO) return true;
  const stored = localStorage.getItem(STORAGE_KEY);
  return !!stored && stored !== DEFAULT_MIRROR;
}
