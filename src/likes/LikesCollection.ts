/**
 * LikesCollection — single owner of "liked tracks" and "liked albums" state.
 *
 * Internally stores a flat `entityId → { kind, likedAt }` map so the two
 * per-kind "is liked" sets and the "when was it liked" map can never drift
 * apart (they're derived from the same source). Each mutation produces a
 * fresh snapshot and calls the injected persister once, atomically.
 *
 * The class is reactive: `trackIds`, `albumIds`, `likedAt` are ComputedRefs
 * — consumers that already consumed the old module-level refs just re-export
 * them as delegates from `src/stores/library.ts`.
 */

import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { LikesSnapshot } from "../persistence/likes.js";

type EntityKind = "track" | "album";

interface LikeEntry {
  kind: EntityKind;
  likedAt: number;
}

export class LikesCollection {
  private readonly _entries: Ref<Map<string, LikeEntry>>;
  private readonly _persist: (snap: LikesSnapshot) => void;

  readonly trackIds: ComputedRef<Set<string>>;
  readonly albumIds: ComputedRef<Set<string>>;
  readonly likedAt: ComputedRef<Map<string, number>>;

  constructor(persist: (snap: LikesSnapshot) => void) {
    this._entries = ref(new Map<string, LikeEntry>());
    this._persist = persist;

    this.trackIds = computed<Set<string>>(() => {
      const s = new Set<string>();
      for (const [id, e] of this._entries.value) if (e.kind === "track") s.add(id);
      return s;
    });
    this.albumIds = computed<Set<string>>(() => {
      const s = new Set<string>();
      for (const [id, e] of this._entries.value) if (e.kind === "album") s.add(id);
      return s;
    });
    this.likedAt = computed<Map<string, number>>(() => {
      const m = new Map<string, number>();
      for (const [id, e] of this._entries.value) m.set(id, e.likedAt);
      return m;
    });
  }

  isTrackLiked(id: string): boolean {
    const e = this._entries.value.get(id);
    return e?.kind === "track";
  }

  isAlbumLiked(id: string): boolean {
    const e = this._entries.value.get(id);
    return e?.kind === "album";
  }

  /** Returns `true` when the entity is liked *after* the call. */
  toggleTrack(id: string): boolean {
    return this._toggle(id, "track");
  }

  /** Returns `true` when the entity is liked *after* the call. */
  toggleAlbum(id: string): boolean {
    return this._toggle(id, "album");
  }

  private _toggle(id: string, kind: EntityKind): boolean {
    if (!id) return false;
    const next = new Map(this._entries.value);
    let liked: boolean;
    if (next.has(id)) {
      next.delete(id);
      liked = false;
    } else {
      next.set(id, { kind, likedAt: Date.now() });
      liked = true;
    }
    this._entries.value = next;
    this._persist(this.toSnapshot());
    return liked;
  }

  /** Flatten the internal map into the persistence snapshot shape. */
  toSnapshot(): LikesSnapshot {
    const trackIds: string[] = [];
    const albumIds: string[] = [];
    const likedAt: Record<string, number> = {};
    for (const [id, e] of this._entries.value) {
      if (e.kind === "track") trackIds.push(id);
      else albumIds.push(id);
      likedAt[id] = e.likedAt;
    }
    return { trackIds, albumIds, likedAt };
  }

  seedFromSnapshot(s: LikesSnapshot): void {
    const next = new Map<string, LikeEntry>();
    for (const id of s.trackIds) {
      next.set(id, { kind: "track", likedAt: Number(s.likedAt[id] ?? 0) });
    }
    for (const id of s.albumIds) {
      next.set(id, { kind: "album", likedAt: Number(s.likedAt[id] ?? 0) });
    }
    this._entries.value = next;
  }
}
