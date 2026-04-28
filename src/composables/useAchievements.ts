/**
 * Achievements composable — opt-in progress tracking persisted in localStorage.
 *
 * Thin Vue-reactive wrapper around {@link AchievementsTracker}: adds a toast
 * UI (title + description refs + open flag) and a watcher that calls
 * `recordPlaybackStarted()` the first time the user starts a track.
 */

import { ref, watch, type Ref, type ComputedRef } from "vue";
import { AchievementsTracker } from "../achievements/AchievementsTracker.js";

export interface UseAchievementsOptions {
  playerPlaying: Ref<boolean>;
  nowPlaying: ComputedRef<object | null>;
}

export function useAchievements(refs: UseAchievementsOptions) {
  const tracker = new AchievementsTracker();

  const achievementToastOpen = ref<boolean>(false);
  const achievementToastTitle = ref<string>("");
  const achievementToastDesc = ref<string>("");

  function showToastForIds(ids: string[]): void {
    if (!ids.length) return;
    const m = tracker.meta(ids[0]!);
    if (!m) return;
    achievementToastTitle.value = m.title;
    achievementToastDesc.value = m.description;
    achievementToastOpen.value = true;
  }

  watch(refs.playerPlaying, (playing, wasPlaying) => {
    if (!playing || !refs.nowPlaying.value) return;
    if (wasPlaying) return;
    showToastForIds(tracker.recordPlaybackStarted());
  });

  function recordLikeChange(likesAfter: number, likesBefore: number): void {
    showToastForIds(tracker.recordLikeChange(likesAfter, likesBefore));
  }

  function handleAchievementsOptInChange(enabled: boolean, likesCount: number): void {
    tracker.setOptIn(enabled, likesCount);
    if (!enabled) achievementToastOpen.value = false;
  }

  function handleAchievementsReset(): void {
    achievementToastOpen.value = false;
    tracker.reset();
  }

  return {
    achievementsOptIn: tracker.optIn,
    achievementsState: tracker.state,
    achievementToastOpen,
    achievementToastTitle,
    achievementToastDesc,
    recordLikeChange,
    handleAchievementsOptInChange,
    handleAchievementsReset,
  };
}
