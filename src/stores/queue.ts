/**
 * Playback queue — pure id list + position.
 *
 * Rows used to carry everything (magnet, fileIdx, slsk creds, etc.) duplicated
 * across queue / likes / playlists. In v2 the queue holds only track ids; the
 * Track (and therefore the URL, cover, refs, …) is resolved through the
 * entities registry / trackCache.
 *
 * Core behaviour lives in `class PlaybackQueue` — bounds checks, pos fix-ups,
 * repeat/shuffle mode all sit as methods with invariants enforced internally.
 * A module-level singleton (`playbackQueue`) is exported, and every named
 * function export below is a thin delegate to it so existing call sites keep
 * working verbatim.
 */

import { ref, computed, type Ref, type ComputedRef } from "vue";
import type { Track } from "../track/Track.js";
import { getTrack, registerEntity, entitiesVersion } from "./entities.js";
import { putTrack, hydrateTrack } from "../persistence/trackCache.js";
import { saveQueueSnapshot, type QueueSnapshot } from "../persistence/queue.js";

export type RepeatMode = "off" | "all" | "one";

const REPEAT_STORAGE_KEY = "neegde.player.repeatMode";
const SHUFFLE_STORAGE_KEY = "neegde.player.shuffle";

function loadRepeatMode(): RepeatMode {
  try {
    const v = localStorage.getItem(REPEAT_STORAGE_KEY);
    return v === "off" || v === "all" || v === "one" ? v : "off";
  } catch { return "off"; }
}
function loadShuffleOn(): boolean {
  try { return localStorage.getItem(SHUFFLE_STORAGE_KEY) === "1"; } catch { return false; }
}

// ── Class ───────────────────────────────────────────────────────────────────

export class PlaybackQueue {
  readonly ids: Ref<string[]> = ref([]);
  readonly pos: Ref<number> = ref(0);
  readonly repeatMode: Ref<RepeatMode> = ref(loadRepeatMode());
  readonly shuffleOn: Ref<boolean> = ref(loadShuffleOn());

  readonly nowPlaying: ComputedRef<Track | null>;
  readonly next: ComputedRef<Track | null>;
  readonly secondNext: ComputedRef<Track | null>;
  readonly hasPrev: ComputedRef<boolean>;
  readonly hasNext: ComputedRef<boolean>;
  /** Track[] view of the queue — resolves each id via the entities registry. */
  readonly tracks: ComputedRef<Track[]>;
  /**
   * After cold-start session restore we don't want HTML autoplay on src assignment.
   * Flipped to `true` by {@link seedFromSnapshot} when it hydrates a non-empty
   * queue, and cleared via {@link allowAutoplay} when the user initiates playback.
   */
  readonly suppressAutoplay: Ref<boolean> = ref(false);

  constructor(private readonly persistFn: (s: QueueSnapshot) => void = saveQueueSnapshot) {
    this.nowPlaying = computed(() => {
      entitiesVersion.value;
      const id = this.ids.value[this.pos.value];
      if (!id) return null;
      return getTrack(id) ?? hydrateTrack(id);
    });

    this.next = computed(() => {
      entitiesVersion.value;
      const ids = this.ids.value;
      const len = ids.length;
      if (len === 0) return null;
      const pos = this.pos.value;
      let nextId: string | undefined;
      if (pos < len - 1) nextId = ids[pos + 1];
      else if (this.repeatMode.value === "all") nextId = ids[0];
      if (!nextId) return null;
      return getTrack(nextId) ?? hydrateTrack(nextId);
    });

    this.secondNext = computed(() => {
      entitiesVersion.value;
      const ids = this.ids.value;
      const len = ids.length;
      if (len < 2) return null;
      const pos = this.pos.value;
      let id: string | undefined;
      if (pos < len - 2) id = ids[pos + 2];
      else if (pos === len - 2 && this.repeatMode.value === "all") id = ids[0];
      else if (this.repeatMode.value === "all") id = len > 2 ? ids[1] : ids[0];
      if (!id) return null;
      return getTrack(id) ?? hydrateTrack(id);
    });

    this.hasPrev = computed(() => {
      const len = this.ids.value.length;
      if (len === 0) return false;
      if (this.pos.value > 0) return true;
      return this.repeatMode.value === "all" && len > 1;
    });

    this.hasNext = computed(() => {
      const len = this.ids.value.length;
      if (len === 0) return false;
      if (this.pos.value < len - 1) return true;
      return this.repeatMode.value === "all";
    });

    this.tracks = computed(() => {
      entitiesVersion.value;
      const out: Track[] = [];
      for (const id of this.ids.value) {
        const t = getTrack(id) ?? hydrateTrack(id);
        if (t) out.push(t);
      }
      return out;
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private persist(): void {
    this.persistFn({ trackIds: this.ids.value, pos: this.pos.value });
  }

  private registerAll(tracks: Track[]): string[] {
    const ids: string[] = [];
    for (const t of tracks) {
      if (!t?.id) continue;
      registerEntity(t);
      putTrack(t);
      ids.push(t.id);
    }
    return ids;
  }

  // ── Mutators ─────────────────────────────────────────────────────────────

  replace(tracks: Track[], startIndex = 0): void {
    this.ids.value = this.registerAll(tracks);
    this.pos.value = Math.max(0, Math.min(startIndex, this.ids.value.length - 1));
    this.persist();
  }

  enqueueTrack(track: Track): void {
    if (!track?.id) return;
    registerEntity(track);
    putTrack(track);
    this.ids.value = [...this.ids.value, track.id];
    this.persist();
  }

  enqueueTracks(tracks: Track[]): void {
    if (!tracks?.length) return;
    const newIds = this.registerAll(tracks);
    this.ids.value = [...this.ids.value, ...newIds];
    this.persist();
  }

  playTrackNow(track: Track): void {
    this.replace([track], 0);
  }

  removeAt(idx: number): void {
    const len = this.ids.value.length;
    if (idx < 0 || idx >= len) return;
    const next = this.ids.value.slice();
    next.splice(idx, 1);
    this.ids.value = next;
    if (idx < this.pos.value) this.pos.value -= 1;
    else if (idx === this.pos.value) this.pos.value = Math.min(this.pos.value, Math.max(0, next.length - 1));
    this.persist();
  }

  moveItem(from: number, to: number): void {
    const len = this.ids.value.length;
    if (from === to || from < 0 || from >= len || to < 0 || to >= len) return;
    const next = this.ids.value.slice();
    const [id] = next.splice(from, 1);
    if (id != null) next.splice(to, 0, id);
    this.ids.value = next;
    const pos = this.pos.value;
    if (pos === from) this.pos.value = to;
    else if (from < pos && to >= pos) this.pos.value = pos - 1;
    else if (from > pos && to <= pos) this.pos.value = pos + 1;
    this.persist();
  }

  clear(): void {
    this.ids.value = [];
    this.pos.value = 0;
    this.persist();
  }

  jumpTo(idx: number): void {
    if (idx < 0 || idx >= this.ids.value.length) return;
    this.pos.value = idx;
    this.persist();
  }

  advance(): void {
    const len = this.ids.value.length;
    if (len === 0) return;
    if (this.pos.value < len - 1) this.pos.value += 1;
    else if (this.repeatMode.value === "all") this.pos.value = 0;
    this.persist();
  }

  rewind(): void {
    const len = this.ids.value.length;
    if (len === 0) return;
    if (this.pos.value > 0) this.pos.value -= 1;
    else if (this.repeatMode.value === "all" && len > 1) this.pos.value = len - 1;
    this.persist();
  }

  setRepeat(mode: RepeatMode): void {
    this.repeatMode.value = mode;
    try { localStorage.setItem(REPEAT_STORAGE_KEY, mode); } catch { /* ignore */ }
  }

  toggleShuffle(): void {
    this.shuffleOn.value = !this.shuffleOn.value;
    try { localStorage.setItem(SHUFFLE_STORAGE_KEY, this.shuffleOn.value ? "1" : "0"); } catch { /* ignore */ }
  }

  seedFromSnapshot(s: QueueSnapshot): void {
    this.ids.value = s.trackIds;
    this.pos.value = Math.max(0, Math.min(s.pos, Math.max(0, s.trackIds.length - 1)));
    // Cold-start session restore: if we hydrated any tracks, suppress HTML
    // autoplay on the next src assignment so the Player only starts on user
    // intent (which clears the flag via `allowAutoplay`).
    this.suppressAutoplay.value = s.trackIds.length > 0;
  }

  /** Clear the autoplay-suppression flag. Called when user initiates playback. */
  allowAutoplay(): void {
    this.suppressAutoplay.value = false;
  }

  snapshot(): QueueSnapshot {
    return { trackIds: this.ids.value.slice(), pos: this.pos.value };
  }
}

// ── Singleton + back-compat named exports ────────────────────────────────────

export const playbackQueue = new PlaybackQueue();

// Reactive refs — direct handles so existing `.value` writers still work.
export const queueIds = playbackQueue.ids;
export const queuePos = playbackQueue.pos;
export const repeatMode = playbackQueue.repeatMode;
export const shuffleOn = playbackQueue.shuffleOn;

// Computed refs
export const nowPlayingTrack = playbackQueue.nowPlaying;
export const nextTrack = playbackQueue.next;
export const secondNextTrack = playbackQueue.secondNext;
export const hasPrev = playbackQueue.hasPrev;
export const hasNext = playbackQueue.hasNext;
export const queueTracks = playbackQueue.tracks;
export const suppressAutoplay = playbackQueue.suppressAutoplay;
export const allowAutoplay = (): void => playbackQueue.allowAutoplay();

// Mutators (thin delegates)
export const replaceQueue = (tracks: Track[], startIndex = 0): void =>
  playbackQueue.replace(tracks, startIndex);
export const enqueueTrack = (track: Track): void =>
  playbackQueue.enqueueTrack(track);
export const enqueueTracks = (tracks: Track[]): void =>
  playbackQueue.enqueueTracks(tracks);
export const playTrackNow = (track: Track): void =>
  playbackQueue.playTrackNow(track);
export const removeAt = (idx: number): void =>
  playbackQueue.removeAt(idx);
export const moveItem = (from: number, to: number): void =>
  playbackQueue.moveItem(from, to);
export const clear = (): void =>
  playbackQueue.clear();
export const jumpTo = (idx: number): void =>
  playbackQueue.jumpTo(idx);
export const next = (): void =>
  playbackQueue.advance();
export const prev = (): void =>
  playbackQueue.rewind();
export const setRepeat = (mode: RepeatMode): void =>
  playbackQueue.setRepeat(mode);
export const toggleShuffle = (): void =>
  playbackQueue.toggleShuffle();
export const seedQueueFromSnapshot = (s: QueueSnapshot): void =>
  playbackQueue.seedFromSnapshot(s);
