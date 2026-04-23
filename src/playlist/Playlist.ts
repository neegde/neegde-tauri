/**
 * Playlist — mutable value object wrapping a `PlaylistSnapshot` row.
 *
 * Holds track ids only; track hydration goes through the entities registry /
 * trackCache. Mutators (rename / addTrack / removeTrack / reorderTracks) enforce
 * uniqueness + bounds checks internally and bump `updatedAt` on success.
 *
 * `Library.*` (see `./Library.ts`) is the canonical mutator caller — it owns
 * the reactive Ref holding all playlists and wraps individual mutations with
 * a snapshot-level bump so Vue re-renders consumers.
 */

import type { PlaylistSnapshot } from "../persistence/playlists.js";

export class Playlist {
  readonly id: string;
  private _title: string;
  private _coverUrl: string | null;
  readonly createdAt: number;
  private _updatedAt: number;
  private readonly _trackIds: string[];

  constructor(data: PlaylistSnapshot) {
    this.id = data.id;
    this._title = data.title;
    this._coverUrl = data.coverUrl ?? null;
    this.createdAt = data.createdAt;
    this._updatedAt = data.updatedAt;
    this._trackIds = data.trackIds.slice();
  }

  // ── Read accessors (used by UI templates directly) ───────────────────────

  get title(): string        { return this._title; }
  get coverUrl(): string | null { return this._coverUrl; }
  get updatedAt(): number    { return this._updatedAt; }
  /** Live view of track ids. Do NOT mutate; use {@link addTrack} etc. */
  get trackIds(): readonly string[] { return this._trackIds; }
  get length(): number       { return this._trackIds.length; }

  hasTrack(trackId: string): boolean {
    return this._trackIds.includes(trackId);
  }

  // ── Mutators — return true on change so callers can skip re-persist ──────

  /** Rename. No-op for empty / unchanged titles. Returns true when applied. */
  rename(newTitle: string): boolean {
    const trimmed = newTitle?.trim();
    if (!trimmed || trimmed === this._title) return false;
    this._title = trimmed;
    this._updatedAt = Date.now();
    return true;
  }

  setCoverUrl(url: string | null): boolean {
    const next = url ?? null;
    if (next === this._coverUrl) return false;
    this._coverUrl = next;
    this._updatedAt = Date.now();
    return true;
  }

  /** Append a track id. Idempotent — duplicates are rejected. */
  addTrack(trackId: string): boolean {
    if (!trackId || this._trackIds.includes(trackId)) return false;
    this._trackIds.push(trackId);
    this._updatedAt = Date.now();
    return true;
  }

  /** Remove a track id. Returns false if it wasn't present. */
  removeTrack(trackId: string): boolean {
    const idx = this._trackIds.indexOf(trackId);
    if (idx < 0) return false;
    this._trackIds.splice(idx, 1);
    this._updatedAt = Date.now();
    return true;
  }

  /**
   * Move a track. Bounds-checks both indices; a noop move (from === to) is
   * rejected so callers don't waste a re-render.
   */
  reorderTracks(fromIdx: number, toIdx: number): boolean {
    const len = this._trackIds.length;
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= len || toIdx >= len) return false;
    const [id] = this._trackIds.splice(fromIdx, 1);
    if (id != null) this._trackIds.splice(toIdx, 0, id);
    this._updatedAt = Date.now();
    return true;
  }

  toSnapshot(): PlaylistSnapshot {
    return {
      id: this.id,
      title: this._title,
      coverUrl: this._coverUrl,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      trackIds: this._trackIds.slice(),
    };
  }
}

function uuid(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a brand-new Playlist with a unique id and zero tracks. */
export function createPlaylistInstance(rawTitle: string): Playlist {
  const now = Date.now();
  return new Playlist({
    id: uuid(),
    title: rawTitle?.trim() || "Без названия",
    coverUrl: null,
    createdAt: now,
    updatedAt: now,
    trackIds: [],
  });
}
