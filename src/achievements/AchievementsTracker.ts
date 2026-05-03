/**
 * AchievementsTracker — consolidates persistence and the state-machine
 * functions (applyPlaybackStarted / applyLikeChange / applyRetroactiveOptIn)
 * behind one object. Consumers (the `useAchievements` composable) wire it to
 * Vue refs and the toast UI.
 *
 * Each mutator returns the list of *newly unlocked* ids, so the composable
 * can decide whether to show a toast without peeking at internal state.
 */

import { ref, type Ref } from "vue";
import {
  loadAchievementsOptIn, saveAchievementsOptIn,
  loadAchievementsState, saveAchievementsState,
  emptyAchievementsProgress,
  type AchievementsProgress,
} from "./achievementsStorage.js";
import {
  applyPlaybackStarted, applyRetroactiveOptIn, applyLikeChange,
  achievementMeta,
  type AchievementDef,
} from "./achievementsCore.js";

export class AchievementsTracker {
  readonly optIn: Ref<boolean>;
  readonly state: Ref<AchievementsProgress>;

  constructor() {
    this.optIn = ref<boolean>(loadAchievementsOptIn());
    this.state = ref<AchievementsProgress>(loadAchievementsState());
  }

  /** Returns ids that became unlocked (empty when opt-out or already unlocked). */
  recordPlaybackStarted(): string[] {
    const r = applyPlaybackStarted(this.state.value, this.optIn.value);
    if (r.state === this.state.value) return [];
    this._commit(r.state);
    return r.newUnlocked;
  }

  /** Same contract as recordPlaybackStarted. */
  recordLikeChange(likesAfter: number, likesBefore: number): string[] {
    if (!this.optIn.value) return [];
    const r = applyLikeChange(this.state.value, true, likesAfter, likesBefore);
    if (r.state === this.state.value) return [];
    this._commit(r.state);
    return r.newUnlocked;
  }

  /**
   * Toggle opt-in. When flipping on, retroactively grants ids already earned
   * (no toast — handled silently). When flipping off, the composable clears
   * its visible toast itself.
   */
  setOptIn(enabled: boolean, likesCount: number): void {
    this.optIn.value = enabled;
    saveAchievementsOptIn(enabled);
    if (!enabled) return;
    const retro = applyRetroactiveOptIn(this.state.value, likesCount);
    if (retro.state !== this.state.value) this._commit(retro.state);
  }

  reset(): void {
    this._commit(emptyAchievementsProgress());
  }

  meta(id: string): AchievementDef | null {
    return achievementMeta(id);
  }

  private _commit(next: AchievementsProgress): void {
    this.state.value = next;
    saveAchievementsState(next);
  }
}
