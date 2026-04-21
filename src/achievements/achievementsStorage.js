/**
 * Persist opt-in flag and unlocked achievement ids (localStorage).
 */

const OPT_IN_KEY = "neegde.achievements.optIn";
const STORAGE_KEY = "neegde.achievements.state.v1";

/**
 * @returns {boolean}
 */
export function loadAchievementsOptIn() {
  return localStorage.getItem(OPT_IN_KEY) === "1";
}

/**
 * @param {boolean} enabled
 * @returns {void}
 */
export function saveAchievementsOptIn(enabled) {
  if (enabled) localStorage.setItem(OPT_IN_KEY, "1");
  else localStorage.removeItem(OPT_IN_KEY);
}

/**
 * @returns {{ unlocked: string[], hasPlayedTrack: boolean }}
 */
export function loadAchievementsState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { unlocked: [], hasPlayedTrack: false };
    }
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") {
      return { unlocked: [], hasPlayedTrack: false };
    }
    const unlocked = Array.isArray(o.unlocked) ? o.unlocked.filter((x) => typeof x === "string") : [];
    return {
      unlocked,
      hasPlayedTrack: Boolean(o.hasPlayedTrack),
    };
  } catch {
    return { unlocked: [], hasPlayedTrack: false };
  }
}

/**
 * Default achievement progress after reset (re-earn from scratch where applicable).
 *
 * Returns:
 *     {{ unlocked: string[], hasPlayedTrack: boolean }}
 */
export function emptyAchievementsProgress() {
  return { unlocked: [], hasPlayedTrack: false };
}

/**
 * @param {{ unlocked: string[], hasPlayedTrack: boolean }} state
 * @returns {void}
 */
export function saveAchievementsState(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        unlocked: state.unlocked,
        hasPlayedTrack: state.hasPlayedTrack,
      })
    );
  } catch (e) {
    console.warn("[achievements] save failed", e);
  }
}
