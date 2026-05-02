import { invoke } from "@tauri-apps/api/core";
import { message, open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Track } from "./Track.js";
import type {
  SoulseekNavigationTarget,
  SoulseekRefs,
  SoulseekTrackSource,
  SoulseekTrackRaw,
  SlskTrackCoverRef,
} from "./types.js";
import type { SoulseekAlbumSource } from "../album/types.js";
import {
  getSlskCoverReactive,
  getSlskCoverDataUrl,
  peekSlskCover,
} from "../soulseek/coverCache.js";
import { isPeerDead, markPeerDead } from "../soulseek/peerBlacklist.js";
import { getAlbum, entitiesVersion, bumpEntitiesVersion } from "../stores/entities.js";
import { putTrack } from "../persistence/trackCache.js";
import { appDebugLog } from "../appDebugLog.js";

const COVER_CANDIDATES = ["folder.jpg", "cover.jpg", "front.jpg", "album.jpg", "cover.png", "folder.png"];

export class SoulseekTrack extends Track {
  private get slskSource(): SoulseekTrackSource {
    return this.source as SoulseekTrackSource;
  }

  private get refs(): SoulseekRefs {
    return this.slskSource.refs;
  }

  /** Peers count stamped by the provider when the track is an orphan singleton. */
  getPeers(): number {
    return this.slskSource.raw?.peers ?? 0;
  }

  /**
   * Best cover ref: parent Album's cover (for album-child tracks), else the
   * track's own ref (set by provider for orphan singletons).
   */
  getCoverRef(): SlskTrackCoverRef | null {
    const own = this.slskSource.raw?.cover ?? null;
    if (own) return own;
    if (this.albumId) {
      const parent = getAlbum(this.albumId);
      const parentSource = parent?.sources?.[0] as SoulseekAlbumSource | undefined;
      const pc = parentSource?.raw?.cover ?? null;
      if (pc) return pc;
    }
    return null;
  }

  override hasPlaybackIdentity(): boolean {
    return Boolean(this.refs.slskUsername && this.refs.slskFilepath);
  }

  /**
   * True when at least one peer (primary or alternative) is not session-
   * blacklisted. Used by search results UI to hide tracks that are already
   * known-dead so the user doesn't click and wait for nothing.
   */
  hasLivePeer(): boolean {
    if (this.refs.slskUsername && !isPeerDead(this.refs.slskUsername)) return true;
    for (const alt of this.slskSource.raw?.alternativePeers ?? []) {
      if (alt?.slskUsername && !isPeerDead(alt.slskUsername)) return true;
    }
    return false;
  }

  /**
   * Ordered list of peers to try: primary first, then alternatives stamped
   * by the search provider. Peers that already failed us in this session
   * are dropped up-front — no point burning another 30-second race on them.
   */
  private peerAttempts(): Array<{ username: string; filepath: string; size: number }> {
    const out: Array<{ username: string; filepath: string; size: number }> = [];
    if (this.refs.slskUsername && this.refs.slskFilepath && !isPeerDead(this.refs.slskUsername)) {
      out.push({
        username: this.refs.slskUsername,
        filepath: this.refs.slskFilepath,
        size: Number(this.size ?? 0),
      });
    }
    for (const alt of this.slskSource.raw?.alternativePeers ?? []) {
      if (!alt?.slskUsername || !alt?.slskFilepath) continue;
      if (isPeerDead(alt.slskUsername)) continue;
      out.push({
        username: alt.slskUsername,
        filepath: alt.slskFilepath,
        size: Number(alt.size ?? 0),
      });
    }
    return out;
  }

  override async prepareStream(): Promise<string> {
    const peers = this.peerAttempts();
    if (peers.length === 0) return "";
    // Fire every peer in parallel — first non-empty URL wins. Trade-off:
    // each losing race still holds a queue slot on its peer until they
    // timeout on their end, but it's the cheapest way to hedge against
    // any single peer being firewalled or stuck. Failed peers are marked
    // dead for the session so subsequent searches don't retry them.
    const TOTAL_TIMEOUT_MS = 30_000;
    const attempts = peers.map((peer) =>
      invoke<{ url: string }>("soulseek_prepare_stream", {
        username: peer.username,
        filepath: peer.filepath,
        filesize: peer.size,
      })
        .then((r) => {
          const url = r?.url ?? "";
          if (!url) throw new Error(`${peer.username}: empty url`);
          return url;
        })
        .catch((e: unknown) => {
          markPeerDead(peer.username);
          throw e;
        }),
    );
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error(`all ${peers.length} peers timed out after ${TOTAL_TIMEOUT_MS}ms`)),
        TOTAL_TIMEOUT_MS,
      ),
    );
    try {
      return await Promise.race([Promise.any(attempts), timeout]);
    } catch (e) {
      if (e instanceof AggregateError) return "";
      throw e;
    }
  }

  override coverUrl(): string | null {
    // Touch the entity-registry version so re-registration of the parent
    // album (e.g. its `raw.cover` getting stamped later) refreshes us.
    entitiesVersion.value;
    const ref = this.getCoverRef();
    if (!ref?.slsk_username || !ref?.slsk_filepath) return null;
    return getSlskCoverReactive(ref.slsk_username, ref.slsk_filepath);
  }

  override startCoverFetch(signal?: AbortSignal): void {
    const ref = this.getCoverRef();
    if (!ref?.slsk_username || !ref?.slsk_filepath) {
      void appDebugLog("cover", `slsk track: no cover ref — id=${this.id}`);
      if (this.refs.slskUsername && this.refs.slskFilepath) void this._guessCoverFromDir(signal);
      return;
    }
    const peek = peekSlskCover(ref.slsk_username, ref.slsk_filepath);
    if (peek !== undefined) {
      if (peek === null) void appDebugLog("cover", `slsk track: neg-TTL skip — user=${ref.slsk_username} file=${ref.slsk_filepath.slice(-60)}`);
      return;
    }
    void appDebugLog("cover", `slsk track: fetch — user=${ref.slsk_username} file=${ref.slsk_filepath.slice(-60)}`);
    void getSlskCoverDataUrl(ref.slsk_username, ref.slsk_filepath, ref.size ?? 0).catch(() => {});
  }

  private _coverGuessInProgress = false;

  private async _guessCoverFromDir(signal?: AbortSignal): Promise<void> {
    if (this._coverGuessInProgress) return;
    this._coverGuessInProgress = true;
    try {
      const username = this.refs.slskUsername;
      const filepath = this.refs.slskFilepath;
      const lastSep = Math.max(filepath.lastIndexOf("\\"), filepath.lastIndexOf("/"));
      if (lastSep === -1) return;
      const dir = filepath.slice(0, lastSep + 1);
      void appDebugLog("cover", `slsk track: guessing cover — user=${username} dir=${dir.slice(-60)}`);
      for (const name of COVER_CANDIDATES) {
        if (signal?.aborted) return;
        const guessPath = dir + name;
        if (peekSlskCover(username, guessPath) === null) continue; // neg-cached
        const result = await getSlskCoverDataUrl(username, guessPath, 0).catch(() => null);
        if (signal?.aborted) return;
        if (result) {
          const src = this.slskSource;
          if (!src.raw) src.raw = {} as SoulseekTrackRaw;
          src.raw.cover = { slsk_username: username, slsk_filepath: guessPath, size: 0 };
          putTrack(this);
          bumpEntitiesVersion();
          void appDebugLog("cover", `slsk track: guess hit — user=${username} file=${name}`);
          return;
        }
      }
      void appDebugLog("cover", `slsk track: guess exhausted — user=${username} dir=${dir.slice(-60)}`);
    } finally {
      this._coverGuessInProgress = false;
    }
  }

  override async exportToDisk(onProgress?: (p: unknown) => void): Promise<void> {
    if (!this.hasPlaybackIdentity()) {
      await message("У трека нет данных SoulSeek.", { title: "Скачивание", kind: "error" });
      return;
    }
    const picked = await open({ directory: true, multiple: false, title: "Выберите папку" });
    if (picked === null) return;
    const destDir = Array.isArray(picked) ? picked[0] : picked;
    const filename = this.refs.slskFilepath.split(/[\\\/]/).pop() || this.fileName || "track";
    const filesize = Number(this.size ?? 0);

    onProgress?.({
      phase: "preparing",
      torrentState: "",
      progressBytes: 0,
      totalBytes: filesize,
      pct: 0,
      queueLabels: [filename],
      message: "Подключение к пиру…",
    });

    let unlisten: () => void = () => {};
    try {
      unlisten = await listen("slsk-export-progress", (ev) => onProgress?.(ev.payload));
      const savedPath = await invoke<string>("soulseek_export_file", {
        username: this.refs.slskUsername,
        filepath: this.refs.slskFilepath,
        filesize,
        destDir,
        fileName: filename,
      });
      const saved = String(savedPath).split(/[\\\/]/).pop() ?? String(savedPath);
      await message(`Сохранено: ${saved}`, { title: "Скачивание" });
    } catch (e) {
      const s = String(e);
      if (/остановлено/i.test(s)) {
        await message("Скачивание остановлено.", { title: "Скачивание", kind: "info" });
      } else {
        await message(s, { title: "Ошибка скачивания", kind: "error" });
      }
    } finally {
      unlisten();
      onProgress?.(null);
    }
  }

  override navigationTarget(): SoulseekNavigationTarget | null {
    if (!this.refs.slskUsername) return null;
    return {
      source: "soulseek",
      slskUsername: this.refs.slskUsername,
      slskFilepath: this.refs.slskFilepath ?? null,
    };
  }

}
