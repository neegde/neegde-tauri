import { invoke } from "@tauri-apps/api/core";

/**
 * @typedef {Object} TrackCandidate
 * @property {string} artist
 * @property {string} title
 * @property {string[]} sources  Which resolver sources returned this pair.
 */

/**
 * @typedef {Object} ResolveResult
 * @property {string}   query        Echoed raw input.
 * @property {{artist:string,title:string}|null} canonical
 *                                   Best-guess pair. Null when no source matched.
 * @property {TrackCandidate[]}      candidates  Up to ~10 dedup'd alternatives.
 * @property {"track"|"artist"|"album"|"lyric"|"raw"} intent
 * @property {number}   elapsed_ms
 */

/**
 * Ask the Rust-side resolver to classify a query. Blocks until every
 * source settles (typically 300–1500 ms; up to ~2 s when Brave's PoW
 * kicks in later). Throws only on ipc / plugin errors — empty results
 * come back as `intent: "raw"` with `canonical: null`.
 *
 * @param {string} query
 * @returns {Promise<ResolveResult>}
 */
export function resolveQuery(query) {
  return invoke("resolve_query", { query });
}
