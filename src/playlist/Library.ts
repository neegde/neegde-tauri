/**
 * Library — owner of the user's Playlist collection.
 *
 * Wraps a reactive `Ref<Playlist[]>` + a by-id index. Every mutator that
 * changes a Playlist's content bumps the ref so Vue re-evaluates dependent
 * computeds (sidebar list, current-playlist view).
 *
 * Persistence is an injected callback — library.ts's module singleton passes
 * `savePlaylistsSnapshot` so any mutation syncs to localStorage.
 */

import { ref, type Ref } from "vue";
import { Playlist, createPlaylistInstance } from "./Playlist.js";
import type { PlaylistSnapshot } from "../persistence/playlists.js";

export type PersistFn = (snapshots: PlaylistSnapshot[]) => void;

export class Library {
  /** Ordered list of Playlist instances. Public read; write via methods. */
  readonly playlists: Ref<Playlist[]> = ref([]);

  constructor(private readonly persistFn: PersistFn = () => {}) {}

  // ── Read ─────────────────────────────────────────────────────────────────

  get(id: string): Playlist | null {
    return this.playlists.value.find((p) => p.id === id) ?? null;
  }

  list(): readonly Playlist[] {
    return this.playlists.value;
  }

  // ── Collection mutators ──────────────────────────────────────────────────

  create(title: string): Playlist {
    const pl = createPlaylistInstance(title);
    this.playlists.value = [...this.playlists.value, pl];
    this.persist();
    return pl;
  }

  delete(id: string): boolean {
    const before = this.playlists.value.length;
    this.playlists.value = this.playlists.value.filter((p) => p.id !== id);
    if (this.playlists.value.length === before) return false;
    this.persist();
    return true;
  }

  seedFromSnapshots(list: PlaylistSnapshot[]): void {
    this.playlists.value = list.map((s) => new Playlist(s));
  }

  // ── Per-playlist mutators — delegate to Playlist, then bump ref + persist ─

  rename(id: string, newTitle: string): boolean {
    const pl = this.get(id);
    if (!pl || !pl.rename(newTitle)) return false;
    this.bump();
    this.persist();
    return true;
  }

  addTrackId(playlistId: string, trackId: string): boolean {
    const pl = this.get(playlistId);
    if (!pl || !pl.addTrack(trackId)) return false;
    this.bump();
    this.persist();
    return true;
  }

  removeTrackId(playlistId: string, trackId: string): boolean {
    const pl = this.get(playlistId);
    if (!pl || !pl.removeTrack(trackId)) return false;
    this.bump();
    this.persist();
    return true;
  }

  reorder(playlistId: string, fromIdx: number, toIdx: number): boolean {
    const pl = this.get(playlistId);
    if (!pl || !pl.reorderTracks(fromIdx, toIdx)) return false;
    this.bump();
    this.persist();
    return true;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private bump(): void {
    // Spread into a new array so Vue picks up array-level reactivity even
    // though the Playlist instances were mutated in place.
    this.playlists.value = this.playlists.value.slice();
  }

  private persist(): void {
    this.persistFn(this.playlists.value.map((p) => p.toSnapshot()));
  }
}
