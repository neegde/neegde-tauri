/**
 * Deezer CDN album art helpers. Search payloads expose several sizes; older
 * app versions preferred `cover_medium`, which looks soft when scaled in the
 * hero / lightbox.
 */

export type DeezerAlbumCoverFields = {
  cover_small?: string | null;
  cover_medium?: string | null;
  cover_big?: string | null;
  cover_xl?: string | null;
};

/**
 * Picks the largest album cover URL Deezer returned for this hit.
 *
 * @param album - `album` object from a Deezer search/track JSON row.
 * @returns Best HTTPS URL or null when none are set.
 */
export function pickBestDeezerAlbumCoverUrl(
  album: DeezerAlbumCoverFields | null | undefined,
): string | null {
  if (!album) return null;
  return (
    album.cover_xl ??
    album.cover_big ??
    album.cover_medium ??
    album.cover_small ??
    null
  );
}

/**
 * Rewrites `…/images/cover/…/WxH-…` on Deezer CDNs toward 1000×1000 when the
 * path still points at a thumbnail, so persisted `cover_medium` URLs render
 * sharply without a new API round-trip.
 *
 * @param url - Any cover URL; non-Deezer URLs are returned unchanged.
 * @returns Rewritten URL or null when input is empty.
 */
export function preferHighResDeezerCoverUrl(url: string | null | undefined): string | null {
  if (url == null || typeof url !== "string") return null;
  const u = url.trim();
  if (!u) return null;
  if (!u.includes("dzcdn.net/images/cover/")) return u;
  return u.replace(/\/(\d{2,4})x(\d{2,4})(-)/, (full, w: string, h: string, dash: string) => {
    const nw = Number(w);
    const nh = Number(h);
    const n = Math.min(nw, nh);
    if (!Number.isFinite(n) || n >= 900) return full;
    return `/1000x1000${dash}`;
  });
}
