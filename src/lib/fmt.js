/**
 * Small pure formatting helpers used by the player's status UI.
 */

/**
 * Human-readable ETA. Returns null when input is non-positive / NaN.
 *   15     → "~15 с"
 *   120    → "~2 мин"
 *   7260   → "~2 ч 1 мин"
 */
export function fmtEtaHuman(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return `~${Math.max(1, Math.round(sec))} с`;
  if (sec < 3600) return `~${Math.round(sec / 60)} мин`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `~${h} ч ${m} мин` : `~${h} ч`;
}

/**
 * Byte-rate formatter. Returns "1.2 МБ/с" / "450 КБ/с" / "900 Б/с".
 */
export function fmtRate(bytesPerSec) {
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} МБ/с`;
  if (bytesPerSec >= 1024)      return `${Math.round(bytesPerSec / 1024)} КБ/с`;
  return `${bytesPerSec} Б/с`;
}

const MEDIA_ERR_NAMES = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/** HTMLMediaElement `error.code` → readable constant name. */
export function describeMediaError(code) {
  return MEDIA_ERR_NAMES[code] ?? `UNKNOWN(${code})`;
}
