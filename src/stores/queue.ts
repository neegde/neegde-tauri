/**
 * Playback queue — pure id list + position.
 *
 * Rows used to carry everything (magnet, fileIdx, slsk creds, etc.) duplicated
 * across queue / likes / playlists. In v2 the queue holds only track ids; the
 * Track (and therefore the URL, cover, refs, …) is resolved through the
 * entities registry / trackCache.
 *
 * Persistence is debounced via the `queue` snapshot module — caller calls
 * mutator methods here, store writes to storage.
 */

import { ref, computed } from "vue";
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

// ── State ───────────────────────────────────────────────────────────────────

export const queueIds = ref<string[]>([]);
export const queuePos = ref<number>(0);
export const repeatMode = ref<RepeatMode>(loadRepeatMode());
export const shuffleOn = ref<boolean>(loadShuffleOn());

// ── Derived ─────────────────────────────────────────────────────────────────

export const nowPlayingTrack = computed<Track | null>(() => {
  entitiesVersion.value;
  const id = queueIds.value[queuePos.value];
  if (!id) return null;
  return getTrack(id) ?? hydrateTrack(id);
});

export const nextTrack = computed<Track | null>(() => {
  entitiesVersion.value;
  const ids = queueIds.value;
  const len = ids.length;
  if (len === 0) return null;
  const pos = queuePos.value;
  let nextId: string | undefined;
  if (pos < len - 1) nextId = ids[pos + 1];
  else if (repeatMode.value === "all") nextId = ids[0];
  if (!nextId) return null;
  return getTrack(nextId) ?? hydrateTrack(nextId);
});

export const secondNextTrack = computed<Track | null>(() => {
  entitiesVersion.value;
  const ids = queueIds.value;
  const len = ids.length;
  if (len < 2) return null;
  const pos = queuePos.value;
  let id: string | undefined;
  if (pos < len - 2) id = ids[pos + 2];
  else if (pos === len - 2 && repeatMode.value === "all") id = ids[0];
  else if (repeatMode.value === "all") id = len > 2 ? ids[1] : ids[0];
  if (!id) return null;
  return getTrack(id) ?? hydrateTrack(id);
});

export const hasPrev = computed<boolean>(() => {
  const len = queueIds.value.length;
  if (len === 0) return false;
  if (queuePos.value > 0) return true;
  return repeatMode.value === "all" && len > 1;
});

export const hasNext = computed<boolean>(() => {
  const len = queueIds.value.length;
  if (len === 0) return false;
  if (queuePos.value < len - 1) return true;
  return repeatMode.value === "all";
});

// ── Persistence sync ───────────────────────────────────────────────────────

function persist(): void {
  saveQueueSnapshot({ trackIds: queueIds.value, pos: queuePos.value });
}

// ── Mutators ────────────────────────────────────────────────────────────────

function registerAll(tracks: Track[]): string[] {
  const ids: string[] = [];
  for (const t of tracks) {
    if (!t?.id) continue;
    registerEntity(t);
    putTrack(t);
    ids.push(t.id);
  }
  return ids;
}

export function replaceQueue(tracks: Track[], startIndex = 0): void {
  queueIds.value = registerAll(tracks);
  queuePos.value = Math.max(0, Math.min(startIndex, queueIds.value.length - 1));
  persist();
}

export function enqueueTrack(track: Track): void {
  if (!track?.id) return;
  registerEntity(track);
  putTrack(track);
  queueIds.value = [...queueIds.value, track.id];
  persist();
}

export function enqueueTracks(tracks: Track[]): void {
  if (!tracks?.length) return;
  const newIds = registerAll(tracks);
  queueIds.value = [...queueIds.value, ...newIds];
  persist();
}

export function playTrackNow(track: Track): void {
  replaceQueue([track], 0);
}

export function removeAt(idx: number): void {
  const len = queueIds.value.length;
  if (idx < 0 || idx >= len) return;
  const next = queueIds.value.slice();
  next.splice(idx, 1);
  queueIds.value = next;
  if (idx < queuePos.value) queuePos.value -= 1;
  else if (idx === queuePos.value) queuePos.value = Math.min(queuePos.value, Math.max(0, next.length - 1));
  persist();
}

export function moveItem(from: number, to: number): void {
  const len = queueIds.value.length;
  if (from === to || from < 0 || from >= len || to < 0 || to >= len) return;
  const next = queueIds.value.slice();
  const [id] = next.splice(from, 1);
  if (id != null) next.splice(to, 0, id);
  queueIds.value = next;
  const pos = queuePos.value;
  if (pos === from) queuePos.value = to;
  else if (from < pos && to >= pos) queuePos.value = pos - 1;
  else if (from > pos && to <= pos) queuePos.value = pos + 1;
  persist();
}

export function clear(): void {
  queueIds.value = [];
  queuePos.value = 0;
  persist();
}

export function jumpTo(idx: number): void {
  if (idx < 0 || idx >= queueIds.value.length) return;
  queuePos.value = idx;
  persist();
}

export function next(): void {
  const len = queueIds.value.length;
  if (len === 0) return;
  if (queuePos.value < len - 1) queuePos.value += 1;
  else if (repeatMode.value === "all") queuePos.value = 0;
  persist();
}

export function prev(): void {
  const len = queueIds.value.length;
  if (len === 0) return;
  if (queuePos.value > 0) queuePos.value -= 1;
  else if (repeatMode.value === "all" && len > 1) queuePos.value = len - 1;
  persist();
}

export function setRepeat(mode: RepeatMode): void {
  repeatMode.value = mode;
  try { localStorage.setItem(REPEAT_STORAGE_KEY, mode); } catch { /* ignore */ }
}

export function toggleShuffle(): void {
  shuffleOn.value = !shuffleOn.value;
  try { localStorage.setItem(SHUFFLE_STORAGE_KEY, shuffleOn.value ? "1" : "0"); } catch { /* ignore */ }
}

/** Populate from persistence snapshot on boot. */
export function seedQueueFromSnapshot(s: QueueSnapshot): void {
  queueIds.value = s.trackIds;
  queuePos.value = Math.max(0, Math.min(s.pos, Math.max(0, s.trackIds.length - 1)));
}
