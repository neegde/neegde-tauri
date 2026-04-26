import { parseBtihFromMagnet } from "../lib/magnet.js";
import { rtTrackId } from "../player/trackForQueue.js";
import type { AlbumData } from "../album/types.js";

type LegacyAudioFile = {
  origIdx?: number;
  path?: string;
  slskUsername?: string;
  slsk_username?: string;
  slskFilepath?: string;
  slsk_filepath?: string;
};

type LegacyAlbumLikeInput = {
  type?: string;
  id?: string;
  source?: string;
  magnet?: string;
  torrentId?: string | number;
  torrentName?: string;
  albumName?: string;
  dirPath?: string;
  audioFiles?: LegacyAudioFile[] | null;
};

/**
 * Reconstructs v2 `AlbumData` from a legacy v1 `makeAlbumLike` / liked row
 * (same rules as the runtime `albumDataFromLikePayload` in App.vue).
 *
 * Args:
 *     row: Object with `type: "album"` and torrent / file fields from storage.
 *
 * Returns:
 *     `AlbumData` for `putAlbum` / `buildAlbum`, or `null` when the row is
 *     incomplete (e.g. SoulSeek with no resolvable user/files).
 */
export function legacyAlbumLikeRowToAlbumData(row: LegacyAlbumLikeInput): AlbumData | null {
  if (!row || row.type !== "album" || !row.id) return null;
  const id = row.id;
  const p = row;
  const files = p.audioFiles ?? [];
  const magnet = p.magnet ?? "";
  const btih = p.source === "magnet" ? parseBtihFromMagnet(magnet) : null;
  const trackIds: string[] = [];
  for (const f of files) {
    if (p.source === "soulseek") {
      const u = f.slskUsername ?? f.slsk_username;
      const spath = f.slskFilepath ?? f.slsk_filepath ?? f.path;
      if (u && spath) trackIds.push(`slsk:track:${u}|${spath}`);
    } else {
      if (f.origIdx == null || !Number.isFinite(f.origIdx)) continue;
      const tid = rtTrackId(p.torrentId, btih, f.origIdx);
      if (tid) trackIds.push(tid);
    }
  }
  if (p.source === "soulseek") {
    const f0 = files[0] ?? files.find(
      (x) => (x.slskUsername ?? x.slsk_username) && (x.slskFilepath ?? x.slsk_filepath),
    );
    const u = f0?.slskUsername ?? f0?.slsk_username;
    if (!f0 || !u) return null;
    let slskFolder = p.dirPath;
    if (!slskFolder || slskFolder === "root") {
      const fp = f0.slskFilepath ?? f0.slsk_filepath ?? f0.path ?? "";
      const parts = String(fp).replace(/\\/g, "/").split("/").filter(Boolean);
      slskFolder = parts.length > 1 ? parts.slice(0, -1).join("/") : String(p.torrentName ?? "album");
    } else {
      slskFolder = String(slskFolder);
    }
    return {
      type: "album",
      id,
      title: p.albumName || p.torrentName || "Album",
      artist: p.torrentName || null,
      trackIds,
      sources: [{ kind: "soulseek", refs: { slskUsername: u, slskFolder } }],
    };
  }
  return {
    type: "album",
    id,
    title: p.albumName || p.torrentName || "Album",
    artist: null,
    trackIds,
    sources: [
      {
        kind: "rutracker",
        refs: {
          topicId: String(p.torrentId),
          rootPath: p.dirPath === "root" ? undefined : p.dirPath,
        },
        raw: { details: { magnet: magnet || undefined } },
      },
    ],
  };
}
