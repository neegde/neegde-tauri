/**
 * Achievements composable — opt-in progress tracking persisted in localStorage.
 *
 * Owns:
 *   - `achievementsOptIn` (boolean ref)
 *   - `achievementsState` (progress object ref)
 *   - toast refs (open / title / desc)
 *
 * Exposes:
 *   - `recordLikeChange(wasLiked, likesAfter, likesBefore)` — call from like handler
 *   - `handleAchievementsOptInChange(enabled, likesCount)` — settings toggle
 *   - `handleAchievementsReset()` — dev/settings reset
 *
 * Playback-started tracking is wired internally against the passed `playerPlaying`
 * + `nowPlaying` refs: it fires the first time `playerPlaying` goes true with a
 * track loaded, exactly matching the previous in-place behaviour.
 */

import { ref, watch } from "vue";
import {
  loadAchievementsOptIn,
  saveAchievementsOptIn,
  loadAchievementsState,
  saveAchievementsState,
  emptyAchievementsProgress,
} from "../achievements/achievementsStorage.js";
import {
  applyPlaybackStarted,
  applyRetroactiveOptIn,
  applyLikeChange,
  achievementMeta,
} from "../achievements/achievementsCore.js";

/**
 * @param {{
 *   playerPlaying: import("vue").Ref<boolean>,
 *   nowPlaying: import("vue").ComputedRef<object | null>,
 * }} refs
 */
export function useAchievements(refs) {
  const achievementsOptIn = ref(loadAchievementsOptIn());
  const achievementsState = ref(loadAchievementsState());

  const achievementToastOpen = ref(false);
  const achievementToastTitle = ref("");
  const achievementToastDesc = ref("");

  function showAchievementToastForIds(ids) {
    if (!ids.length) return;
    const m = achievementMeta(ids[0]);
    if (!m) return;
    achievementToastTitle.value = m.title;
    achievementToastDesc.value = m.description;
    achievementToastOpen.value = true;
  }

  function commitState(nextState, newUnlocked) {
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

  function recordLikeChange(likesAfter, likesBefore) {
    if (!achievementsOptIn.value) return;
    const lr = applyLikeChange(achievementsState.value, true, likesAfter, likesBefore);
    if (lr.state !== achievementsState.value) {
      commitState(lr.state, lr.newUnlocked);
    }
  }

  function handleAchievementsOptInChange(enabled, likesCount) {
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

  function handleAchievementsReset() {
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
