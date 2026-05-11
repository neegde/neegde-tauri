/**
 * Fuzzy track matching for the import pipeline.
 *
 * Strategy:
 *   - Normalize both strings: lowercase, strip diacritics, strip track numbers,
 *     strip file extensions, replace punctuation with spaces.
 *   - Compare using Dice coefficient on token sets.
 *   - Combine artist similarity (35%) + title similarity (65%).
 *   - Require at least some title overlap (prevents all-artist-match false positives).
 */

import { resolveTrackNames, type TrackNameInput } from "../track/nameResolver.js";

/**
 * Normalize a string for fuzzy comparison.
 * Handles Russian ё→е, strips track number prefixes and audio extensions.
 */
export function normStr(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")                                          // strip diacritics
    .replace(/ё/g, "е")                                              // Russian ё→е
    .replace(/^\d+[\s.\-–—)+:]+/, "")                               // strip "01 - ", "1. "…
    .replace(/\.(flac|mp3|ogg|ape|wav|m4a|alac|aac|opus|dsf|dff|wma)$/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normStr(s).split(" ").filter((w) => w.length > 0));
}

/** Dice coefficient on token sets (0..1). */
function diceSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return (2 * common) / (A.size + B.size);
}

export interface ScoreResult {
  score: number;      // combined 0..1
  artistSim: number;  // 0..1
  titleSim: number;   // 0..1
}

/**
 * Score how well a track matches a target artist + title.
 * Uses resolveTrackNames so both RT filenames and SLSK paths are handled.
 */
export function scoreMatch(
  track: TrackNameInput,
  targetArtist: string,
  targetTitle: string,
): ScoreResult {
  const resolved = resolveTrackNames(track);

  const trackTitle  = resolved.title  || track.fileName || "";
  const trackArtist = resolved.artist || "";

  const titleSim  = diceSim(targetTitle, trackTitle);
  // When track has no artist (e.g. SLSK from unknown folder), use neutral 0.5
  const artistSim = trackArtist ? diceSim(targetArtist, trackArtist) : 0.5;

  // Title is more discriminating than artist
  const score = titleSim * 0.65 + artistSim * 0.35;
  return { score, artistSim, titleSim };
}

export interface BestMatch<T> {
  track: T;
  score: number;
  artistSim: number;
  titleSim: number;
}

/**
 * Find the best matching track from a list.
 * Returns null if no track clears the minimum score threshold.
 *
 * @param minScore - Combined score threshold (default 0.50).
 *                   Title similarity must also be ≥ 0.30 independently.
 */
export function findBestMatch<T extends TrackNameInput>(
  tracks: T[],
  targetArtist: string,
  targetTitle: string,
  minScore = 0.50,
): BestMatch<T> | null {
  let best: BestMatch<T> | null = null;

  for (const track of tracks) {
    const { score, artistSim, titleSim } = scoreMatch(track, targetArtist, targetTitle);
    // Require some title overlap — a high artist sim alone is not enough
    if (titleSim < 0.30) continue;
    if (score > (best?.score ?? minScore - 0.001)) {
      best = { track, score, artistSim, titleSim };
    }
  }

  return best;
}
