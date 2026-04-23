import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { Track } from "./Track.js";
import type { NavigationTarget, RutrackerRefs, TrackSource } from "./types.js";
import {
  getCoverReactive,
  getRutrackerCoverDataUrl,
  peekRutrackerCover,
} from "../rutracker/coverCache.js";

export class RutrackerTrack extends Track {
  protected readonly sourceKind: "rutracker" | "magnet" = "rutracker";

  protected get refs(): RutrackerRefs {
    return (this.source as TrackSource & { kind: "rutracker" | "magnet" }).refs as RutrackerRefs;
  }

  override hasPlaybackIdentity(): boolean {
    return Boolean(this.refs.magnet);
  }

  override async prepareStream(): Promise<string> {
    if (!this.hasPlaybackIdentity()) return "";
    const ready = await invoke<{ url: string } | null>("torrent_prepare_stream", {
      magnet: this.refs.magnet,
      fileIdx: this.refs.fileIdx,
      torrentFileB64: null,
    });
    return ready?.url ?? "";
  }

  override coverUrl(): string | null {
    if (this.data.coverUrl) return this.data.coverUrl;
    const topicId = this.refs.topicId;
    if (!topicId) return null;
    return getCoverReactive(String(topicId));
  }

  override startCoverFetch(): void {
    const topicId = this.refs.topicId;
    if (!topicId) return;
    if (peekRutrackerCover(String(topicId)) !== undefined) return;
    void getRutrackerCoverDataUrl(String(topicId)).catch(() => {});
  }

  override async exportToDisk(): Promise<void> {
    // Single-track RT export goes through TorrentView's `exportTorrentFiles`
    // today (needs magnet + file index list). Keep a friendly stub here so
    // Track.exportToDisk(track) is safe to call uniformly.
    await message(
      "Скачивание одного трека RuTracker: откройте раздачу и нажмите кнопку скачивания.",
      { title: "Скачивание", kind: "info" },
    );
  }

  override navigationTarget(): NavigationTarget | null {
    return {
      torrentId: this.refs.topicId ?? this.id,
      torrentName: this.albumTitle ?? "",
      source: this.sourceKind,
      magnet: this.refs.magnet ?? "",
      artist: this.artist,
      seeders: null,
      fileIdx: this.refs.fileIdx ?? 0,
      albumDirPath: this.refs.albumDirPath ?? null,
    };
  }

}

/**
 * Magnet-only tracks share the RuTracker flow — same Rust command, same
 * refs shape. Only the `source` label on emitted rows differs.
 */
export class MagnetTrack extends RutrackerTrack {
  protected override readonly sourceKind = "magnet" as const;
}
