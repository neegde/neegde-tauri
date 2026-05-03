/**
 * Pure helpers for working with `magnet:?…` URIs.
 * No UI / no state — free to import from any module.
 */

/**
 * Extract a `magnet:?…` substring from pasted text (extra words or quotes allowed).
 * Returns the URI or null if none found.
 */
export function extractMagnetUri(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const lower = s.toLowerCase();
  const i = lower.indexOf("magnet:?");
  if (i < 0) return null;
  const slice = s.slice(i);
  const end = slice.search(/\s/);
  const core = end < 0 ? slice : slice.slice(0, end);
  return core.replace(/[),.;>]+$/g, "");
}

/**
 * Parse the BTIH (hex or base32) from a magnet link for stable synthetic ids.
 * Returns a lowercase hash string or null.
 */
export function parseBtihFromMagnet(magnet: unknown): string | null {
  const u = String(magnet ?? "");
  const hex = /btih:([a-fA-F0-9]{40})/i.exec(u);
  if (hex) return hex[1]!.toLowerCase();
  const b32 = /btih:([a-z2-7]{32})/i.exec(u);
  if (b32) return b32[1]!.toLowerCase();
  return null;
}

/**
 * Human-readable title for a magnet-only torrent: the `dn` parameter when present,
 * else a short-hash fallback. Always returns a non-empty string.
 */
export function magnetTitleFromMagnet(magnet: unknown): string {
  const u = String(magnet ?? "");
  const dn = /[?&]dn=([^&]+)/.exec(u);
  if (dn) {
    const spaced = dn[1]!.replace(/\+/g, " ");
    const fixed = spaced.replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
    const t = decodeURIComponent(fixed).trim();
    if (t) return t;
  }
  const h = parseBtihFromMagnet(u);
  return h ? `Раздача ${h.slice(0, 8)}…` : "Раздача по ссылке";
}
