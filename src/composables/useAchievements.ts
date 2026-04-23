/**
 * Achievements composable — opt-in progress tracking persisted in localStorage.
 */

import { ref, watch, type Ref, type ComputedRef } from "vue";
import {
  loadAchievementsOptIn, saveAchievementsOptIn,
  loadAchievementsState, saveAchievementsState,
  emptyAchievementsProgress,
  type AchievementsProgress,
} from "../achievements/achievementsStorage.js";
import {
  applyPlaybackStarted, applyRetroactiveOptIn, applyLikeChange,
  achievementMeta,
} from "../achievements/achievementsCore.js";

export interface UseAchievementsOptions {
  playerPlaying: Ref<boolean>;
  nowPlaying: ComputedRef<object | null>;
}

export function useAchievements(refs: UseAchievementsOptions) {
  const achievementsOptIn = ref<boolean>(loadAchievementsOptIn());
  const achievementsState = ref<AchievementsProgress>(loadAchievementsState());

  const achievementToastOpen = ref<boolean>(false);
  const achievementToastTitle = ref<string>("");
  const achievementToastDesc = ref<string>("");

  function showAchievementToastForIds(ids: string[]): void {
    if (!ids.length) return;
    const m = achievementMeta(ids[0]!);
    if (!m) return;
    achievementToastTitle.value = m.title;
    achievementToastDesc.value = m.description;
    achievementToastOpen.value = true;
  }

  function commitState(nextState: AchievementsProgress, newUnlocked: string[]): void {
    achievementsState.value = nextState;
    saveAchievementsState(nextState);
    if (achievementsOptIn.value && newUnlocked.length) {
      showAchievementToastForIds(newUnlocked);
    }
  }

  watch(refs.playerPlaying, (playing, wasPlaying) => {
    if (!playing || !refs.nowPlaying.value) return;
    if (wasPlaying) return;
    const r = applyPlaybackStarted(achievementsState.value, achievementsOptIn.value);
    if (r.state === achievementsState.value) return;
    commitState(r.state, r.newUnlocked);
  });

  function recordLikeChange(likesAfter: number, likesBefore: number): void {
    if (!achievementsOptIn.value) return;
    const lr = applyLikeChange(achievementsState.value, true, likesAfter, likesBefore);
    if (lr.state !== achievementsState.value) {
      commitState(lr.state, lr.newUnlocked);
    }
  }

  function handleAchievementsOptInChange(enabled: boolean, likesCount: number): void {
    achievementsOptIn.value = enabled;
    saveAchievementsOptIn(enabled);
    if (!enabled) {
      achievementToastOpen.value = false;
      return;
    }
    const retro = applyRetroactiveOptIn(achievementsState.value, likesCount);
    if (retro.state !== achievementsState.value) {
      achievementsState.value = retro.state;
      saveAchievementsState(retro.state);
    }
  }

  function handleAchievementsReset(): void {
    achievementToastOpen.value = false;
    const next = emptyAchievementsProgress();
    achievementsState.value = next;
    saveAchievementsState(next);
  }

  return {
    achievementsOptIn,
    achievementsState,
    achievementToastOpen,
    achievementToastTitle,
    achievementToastDesc,
    recordLikeChange,
    handleAchievementsOptInChange,
    handleAchievementsReset,
  };
}
