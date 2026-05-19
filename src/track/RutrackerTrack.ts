import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { Track } from "./Track.js";
import type {
  RutrackerNavigationTarget,
  RutrackerRefs,
  RutrackerTrackSource,
  MagnetTrackSource,
  RutrackerTrackRaw,
} from "./types.js";
import {
  getCoverReactive,
  getRutrackerCoverDataUrl,
  peekRutrackerCover,
} from "../rutracker/coverCache.js";
import { enrichMagnetWithOpenTrackers } from "../lib/utils.js";
import { torrentFileB64ForTrack } from "../torrent/api.js";
import { appDebugLog } from "../appDebugLog.js";

export class RutrackerTrack extends Track {
  protected readonly sourceKind: "rutracker" | "magnet" = "rutracker";

  private get rtSource(): RutrackerTrackSource | MagnetTrackSource {
    return this.source as RutrackerTrackSource | MagnetTrackSource;
  }

  protected get refs(): RutrackerRefs {
    return this.rtSource.refs as RutrackerRefs;
  }

  protected get rtRaw(): RutrackerTrackRaw | undefined {
    return this.rtSource.raw;
  }

  /**
   * Resolve magnet: direct refs first, else fall through to `raw.details.magnet`
   * which the RuTracker search provider stamps on track emissions (the whole
   * topic shares one magnet; duplicating it per-track refs would bloat the
   * entity). Null when neither is available.
   */
  private getMagnet(): string {
    if (this.refs.magnet) return this.refs.magnet;
    return this.rtRaw?.details?.magnet ?? "";
  }

  override hasPlaybackIdentity(): boolean {
    return Boolean(this.getMagnet());
  }

  override async prepareStream(): Promise<string> {
    const magnet = this.getMagnet();
    if (!magnet) return "";
    // Pull the .torrent file up-front if we can (rutracker source only —
    // magnet-only tracks don't have a topic to fetch from). Without it C++
    // has to resolve metadata over DHT / trackers which hangs for 90 s on
    // restricted networks. With it, metadata is instant.
    const torrentFileB64 = await torrentFileB64ForTrack({
      source: this.sourceKind,
      torrentId: this.refs.topicId ?? undefined,
    }).catch(() => null);
    const ready = await invoke<{ url: string } | null>("torrent_prepare_stream", {
      magnet: enrichMagnetWithOpenTrackers(magnet),
      fileIdx: this.refs.fileIdx,
      torrentFileB64,
    });
    return ready?.url ?? "";
  }

  override coverUrl(): string | null {
    if (this.data.coverUrl) return this.data.coverUrl;
    const topicId = this.refs.topicId;
    if (!topicId) return null;
    return getCoverReactive(String(topicId));
  }

  override startCoverFetch(_signal?: AbortSignal, _opts?: unknown): void {
    const topicId = this.refs.topicId;
    if (!topicId) return;
    const peek = peekRutrackerCover(String(topicId));
    if (peek !== undefined) {
      if (peek === null) void appDebugLog("cover", `rt track: neg-TTL skip — topicId=${topicId}`);
      return;
    }
    void appDebugLog("cover", `rt track: fetch — topicId=${topicId}`);
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

  override navigationTarget(): RutrackerNavigationTarget | null {
    return {
      source: this.sourceKind,
      torrentId: this.refs.topicId ?? this.id,
      torrentName: this.albumTitle ?? "",
      magnet: this.getMagnet(),
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
