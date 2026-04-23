/**
 * Persist opt-in flag and unlocked achievement ids (localStorage).
 */

const OPT_IN_KEY = "neegde.achievements.optIn";
const STORAGE_KEY = "neegde.achievements.state.v1";

export interface AchievementsProgress {
  unlocked: string[];
  hasPlayedTrack: boolean;
}

export function loadAchievementsOptIn(): boolean {
  return localStorage.getItem(OPT_IN_KEY) === "1";
}

export function saveAchievementsOptIn(enabled: boolean): void {
  if (enabled) localStorage.setItem(OPT_IN_KEY, "1");
  else localStorage.removeItem(OPT_IN_KEY);
}

export function loadAchievementsState(): AchievementsProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { unlocked: [], hasPlayedTrack: false };
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return { unlocked: [], hasPlayedTrack: false };
    const unlocked = Array.isArray(o.unlocked)
      ? o.unlocked.filter((x: unknown): x is string => typeof x === "string")
      : [];
    return { unlocked, hasPlayedTrack: Boolean(o.hasPlayedTrack) };
  } catch {
    return { unlocked: [], hasPlayedTrack: false };
  }
}

export function emptyAchievementsProgress(): AchievementsProgress {
  return { unlocked: [], hasPlayedTrack: false };
}

export function saveAchievementsState(state: AchievementsProgress): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        unlocked: state.unlocked,
        hasPlayedTrack: state.hasPlayedTrack,
      }),
    );
  } catch (e) {
    console.warn("[achievements] save failed", e);
  }
}
