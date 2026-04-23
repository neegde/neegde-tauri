/**
 * Catalog and unlock rules for optional «achievements» (opt-in fun stats).
 */

import type { AchievementsProgress } from "./achievementsStorage.js";

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  stub?: boolean;
}

export const ACHIEVEMENT_CATALOG: AchievementDef[] = [
  { id: "first_sound", title: "Первый звук",        description: "Впервые запустили воспроизведение трека." },
  { id: "first_heart", title: "В избранном",         description: "Добавили первый трек в «Мне нравится»." },
  {
    id: "same_track_1000_min",
    title: "1000 минут одной песни",
    description: "Ты просил — строчка в списке есть. Считать за тебя минуты я не собираюсь азаз",
    stub: true,
  },
];

export function achievementMeta(id: string): AchievementDef | null {
  return ACHIEVEMENT_CATALOG.find((a) => a.id === id) ?? null;
}

export interface ApplyResult {
  state: AchievementsProgress;
  newUnlocked: string[];
  silentGranted: string[];
}

/** Registers first playback for stats; unlocks only when opt-in is on. */
export function applyPlaybackStarted(state: AchievementsProgress, optIn: boolean): ApplyResult {
  if (state.hasPlayedTrack) {
    return { state, newUnlocked: [], silentGranted: [] };
  }
  let next: AchievementsProgress = { ...state, hasPlayedTrack: true };
  const newUnlocked: string[] = [];
  if (optIn && !next.unlocked.includes("first_sound")) {
    next = { ...next, unlocked: [...next.unlocked, "first_sound"] };
    newUnlocked.push("first_sound");
  }
  return { state: next, newUnlocked, silentGranted: [] };
}

/** When user opts in, grant titles already earned without toast spam. */
export function applyRetroactiveOptIn(
  state: AchievementsProgress,
  likesCount: number | null | undefined,
): { state: AchievementsProgress; silentGranted: string[] } {
  let next = { ...state };
  const silentGranted: string[] = [];
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

/** Like-toggle side effects on achievements. */
export function applyLikeChange(
  state: AchievementsProgress,
  optIn: boolean,
  likesTotalAfter: number,
  likesTotalBefore: number,
): { state: AchievementsProgress; newUnlocked: string[] } {
  const before = Number(likesTotalBefore);
  const after = Number(likesTotalAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return { state, newUnlocked: [] };
  }
  let next = { ...state };
  const newUnlocked: string[] = [];
  if (!optIn) {
    return { state: next, newUnlocked: [] };
  }
  if (before === 0 && after === 1 && !next.unlocked.includes("first_heart")) {
    next = { ...next, unlocked: [...next.unlocked, "first_heart"] };
    newUnlocked.push("first_heart");
  }
  return { state: next, newUnlocked };
}
