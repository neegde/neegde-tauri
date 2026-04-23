/**
 * Non-blocking track metadata enrichment via MusicBrainz API.
 */

import { isYearLike } from "../lib/utils.js";

const MB  = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org";

export interface TrackMeta {
  artist: string;
  album: string;
  title: string;
  coverUrl: string | null;
}

export interface AlbumTracklistMeta {
  artist: string;
  album: string;
  coverUrl: string | null;
  tracksByNumber: Map<number, string>;
}

const cache = new Map<string, unknown>();

let lastSent = 0;
interface PendingReq { url: string; resolve: (r: Response) => void; reject: (e: unknown) => void }
const pending: PendingReq[] = [];
let draining = false;

function enqueue(url: string): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    pending.push({ url, resolve, reject });
    if (!draining) void drain();
  });
}

async function drain(): Promise<void> {
  draining = true;
  while (pending.length) {
    const gap = lastSent + 1050 - Date.now();
    if (gap > 0) await sleep(gap);
    const task = pending.shift()!;
    lastSent = Date.now();
    try {
      const r = await fetch(task.url, {
        signal: AbortSignal.timeout(9000),
        headers: { Accept: "application/json" },
      });
      task.resolve(r);
    } catch (e) {
      task.reject(e);
    }
  }
  draining = false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function mbGet(url: string): Promise<unknown | null> {
  try {
    const r = await enqueue(url);
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

function enc(s: string): string {
  return encodeURIComponent(`"${s.replace(/["\\]/g, "\\$&")}"`);
}

function caaFront(mbid: string): string {
  return `${CAA}/release/${mbid}/front-250`;
}

export async function enrichTrackMeta(
  artist: string,
  title: string,
  onResult: (r: TrackMeta) => void,
): Promise<void> {
  if (!artist || !title || artist.length < 2 || title.length < 2) return;
  if (isYearLike(artist.trim())) return;

  const key = `track\0${artist.toLowerCase()}\0${title.toLowerCase()}`;
  if (cache.has(key)) {
    const cached = cache.get(key) as TrackMeta | null;
    if (cached) onResult(cached);
    return;
  }

  const url = `${MB}/recording/?query=artist:${enc(artist)}+AND+recording:${enc(title)}&fmt=json&limit=3`;
  const data = (await mbGet(url)) as { recordings?: Array<Record<string, unknown>> } | null;
  const hit = data?.recordings?.[0];
  if (!hit) { cache.set(key, null); return; }

  const releases = hit.releases as Array<{ id?: string; title?: string }> | undefined;
  const mbid = releases?.[0]?.id ?? null;
  const artistCredit = hit["artist-credit"] as Array<{ artist?: { name?: string } }> | undefined;
  const result: TrackMeta = {
    artist:   artistCredit?.[0]?.artist?.name ?? artist,
    album:    releases?.[0]?.title ?? "",
    title:    (hit.title as string) ?? title,
    coverUrl: mbid ? caaFront(mbid) : null,
  };
  cache.set(key, result);
  onResult(result);
}

export async function enrichAlbumTracklist(
  artist: string,
  albumName: string,
): Promise<AlbumTracklistMeta | null> {
  if (!artist || !albumName || artist.length < 2 || albumName.length < 2) return null;
  if (isYearLike(artist.trim())) return null;

  const key = `album\0${artist.toLowerCase()}\0${albumName.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key) as AlbumTracklistMeta | null;

  const url1 = `${MB}/release/?query=artist:${enc(artist)}+AND+release:${enc(albumName)}&fmt=json&limit=1`;
  const d1 = (await mbGet(url1)) as { releases?: Array<{ id?: string }> } | null;
  const rel = d1?.releases?.[0];
  if (!rel?.id) { cache.set(key, null); return null; }

  const url2 = `${MB}/release/${rel.id}?inc=recordings&fmt=json`;
  interface ReleaseResp {
    media?: Array<{ tracks?: Array<{ position?: number; number?: string; recording?: { title?: string } }> }>;
    title?: string;
    "artist-credit"?: Array<{ artist?: { name?: string } }>;
  }
  const d2 = (await mbGet(url2)) as ReleaseResp | null;
  if (!d2) { cache.set(key, null); return null; }

  const tracksByNumber = new Map<number, string>();
  for (const medium of d2.media ?? []) {
    for (const t of medium.tracks ?? []) {
      const num = t.position ?? Number(t.number);
      if (num != null && t.recording?.title) {
        tracksByNumber.set(num, t.recording.title);
      }
    }
  }

  const relCredit = (rel as unknown as { "artist-credit"?: Array<{ artist?: { name?: string } }> })["artist-credit"];
  const mbArtist =
    d2["artist-credit"]?.[0]?.artist?.name
    ?? relCredit?.[0]?.artist?.name;
  const fallbackArtist = mbArtist && !isYearLike(String(mbArtist).trim()) ? mbArtist : artist;
  const result: AlbumTracklistMeta = {
    artist:        fallbackArtist,
    album:         d2.title ?? albumName,
    coverUrl:      caaFront(rel.id),
    tracksByNumber,
  };
  cache.set(key, result);
  return result;
}
