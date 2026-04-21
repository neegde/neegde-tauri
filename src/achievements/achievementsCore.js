/**
 * Catalog and unlock rules for optional «achievements» (opt-in fun stats).
 */

export const ACHIEVEMENT_CATALOG = [
  {
    id: "first_sound",
    title: "Первый звук",
    description: "Впервые запустили воспроизведение трека.",
  },
  {
    id: "first_heart",
    title: "В избранном",
    description: "Добавили первый трек в «Мне нравится».",
  },
  {
    id: "same_track_1000_min",
    title: "1000 минут одной песни",
    description:
      "Ты просил — строчка в списке есть. Считать за тебя минуты я не собираюсь азаз",
    stub: true,
  },
];

/**
 * @param {string} id
 * @returns {{ id: string, title: string, description: string, stub?: boolean } | null}
 */
export function achievementMeta(id) {
  return ACHIEVEMENT_CATALOG.find((a) => a.id === id) ?? null;
}

/**
 * Registers first playback for stats; unlocks only when opt-in is on.
 *
 * Args:
 *     state: Persisted achievement state.
 *     optIn: User enabled achievements in settings.
 *
 * Returns:
 *     {{ state: object, newUnlocked: string[], silentGranted: string[] }}
 */
export function applyPlaybackStarted(state, optIn) {
  if (state.hasPlayedTrack) {
    return { state, newUnlocked: [], silentGranted: [] };
  }
  let next = { ...state, hasPlayedTrack: true };
  const newUnlocked = [];
  if (optIn && !next.unlocked.includes("first_sound")) {
    next = { ...next, unlocked: [...next.unlocked, "first_sound"] };
    newUnlocked.push("first_sound");
  }
  return { state: next, newUnlocked, silentGranted: [] };
}

/**
 * When user opts in, grant titles they already earned without toast spam.
 *
 * Args:
 *     state: Persisted achievement state.
 *     likesCount: Current number of saved likes.
 *
 * Returns:
 *     {{ state: object, silentGranted: string[] }}
 */
export function applyRetroactiveOptIn(state, likesCount) {
  let next = { ...state };
  const silentGranted = [];
  if (next.hasPlayedTrack && !next.unlocked.includes("first_sound")) {
    next = { ...next, unlocked: [...next.unlocked, "first_sound"] };
    silentGranted.push("first_sound");
  }
  const n = Number(likesCount);
  if (Number.isFinite(n) && n > 0 && !next.unlocked.includes("first_heart")) {
    next = { ...next, unlocked: [...next.unlocked, "first_heart"] };
    silentGranted.push("first_heart");
  }
  return { state: next, silentGranted };
}

/**
 * Args:
 *     state: Persisted achievement state.
 *     optIn: User enabled achievements.
 *     likesTotalAfter: Like count after toggle.
 *     likesTotalBefore: Like count before toggle.
 *
 * Returns:
 *     {{ state: object, newUnlocked: string[] }}
 */
export function applyLikeChange(state, optIn, likesTotalAfter, likesTotalBefore) {
  const before = Number(likesTotalBefore);
  const after = Number(likesTotalAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return { state, newUnlocked: [] };
  }
  let next = { ...state };
  const newUnlocked = [];
  if (!optIn) {
    return { state: next, newUnlocked: [] };
  }
  if (before === 0 && after === 1 && !next.unlocked.includes("first_heart")) {
    next = { ...next, unlocked: [...next.unlocked, "first_heart"] };
    newUnlocked.push("first_heart");
  }
  return { state: next, newUnlocked };
}
