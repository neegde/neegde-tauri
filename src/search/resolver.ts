import { invoke } from "@tauri-apps/api/core";

export interface TrackCandidate {
  artist: string;
  title: string;
  /** Which resolver sources returned this pair. */
  sources: string[];
}

export interface ResolveResult {
  /** Echoed raw input. */
  query: string;
  /** Best-guess pair. Null when no source matched. */
  canonical: { artist: string; title: string } | null;
  /** Up to ~10 dedup'd alternatives. */
  candidates: TrackCandidate[];
  intent: "track" | "artist" | "album" | "lyric" | "raw";
  elapsed_ms: number;
}

/**
 * Ask the Rust-side resolver to classify a query. Blocks until every source
 * settles (typically 300–1500 ms; up to ~2 s when Brave's PoW kicks in).
 * Throws only on ipc / plugin errors — empty results come back as
 * `intent: "raw"` with `canonical: null`.
 */
export function resolveQuery(query: string): Promise<ResolveResult> {
  return invoke<ResolveResult>("resolve_query", { query });
}
