import { rutrackerProvider } from "./providers/rutracker.js";
import { soulseekProvider } from "./providers/soulseek.js";
import { SearchSession } from "./session.js";
import { SessionCache } from "./cache.js";
import { defaultPipeline } from "./pipeline/index.js";
import { resolveQuery } from "./resolver.js";

/**
 * Normalize a raw query into the shape used for cache keys.
 * Same rules as the old `_searchCache` in App.vue: trim + lowercase.
 */
function normalizeQuery(q) {
  return String(q ?? "").trim().toLowerCase();
}

/**
 * Create the search engine. Exactly one instance per app session — it
 * owns the provider registry, the session cache, and the default
 * pipeline. A second instance would just be a second cache; there's
 * no reason to have one.
 *
 * @param {object} [opts]
 * @param {(tag: string, msg: string) => void} [opts.log]
 * @param {number} [opts.cacheMax]
 */
export function createSearchEngine(opts = {}) {
  const log = opts.log ?? (() => {});
  const cache = new SessionCache(opts.cacheMax ?? 30);

  // Registry: provider instances keyed by kind. Later providers get
  // appended here without touching consumers.
  /** @type {Record<string, import("../types/entities.js").SearchProvider>} */
  const registry = {
    rutracker: rutrackerProvider,
    soulseek:  soulseekProvider,
  };

  /**
   * Start a search.
   *
   * The query passes through the Rust-side **resolver** before hitting
   * providers: raw user input → `{ canonical, candidates, intent }` →
   * providers receive the canonical "{artist} {title}" string. That way
   * "paranoid android" becomes "Radiohead Paranoid Android" before it
   * ever reaches SoulSeek / RuTracker, and lyric snippets (which
   * substring search can't handle) get resolved to real track titles.
   *
   * @param {string} query
   * @param {object} enabled  Map of provider-kind → boolean. Providers
   *                          with truthy entries are started; others
   *                          are absent from the session entirely.
   * @param {object} [opts]
   * @param {boolean} [opts.skipResolver]   Skip the resolver and send the
   *                                        raw query to providers. Also
   *                                        bypasses the session cache so
   *                                        the "search as literal string"
   *                                        UI can always force a fresh run.
   * @returns {Promise<import("./session.js").SearchSession>}
   */
  async function query(query_, enabled, opts = {}) {
    const qnRaw = normalizeQuery(query_);
    const enabledKinds = Object.keys(registry)
      .filter((k) => enabled?.[k])
      .sort();
    const cacheKey = `${qnRaw}|${enabledKinds.join(",")}`;

    if (!opts.skipResolver) {
      const cached = cache.get(cacheKey);
      if (cached) {
        log("engine", `cache hit: "${qnRaw}" [${enabledKinds.join(",")}]`);
        return cached;
      }
    }

    if (!qnRaw) {
      // Empty query: return an already-completed empty session, NOT cached
      // (no point cluttering the LRU with empties).
      return new SearchSession("", { providers: [], log });
    }

    let resolved = null;
    if (!opts.skipResolver) {
      // Resolver call — blocks while iTunes/LRCLIB (and, later, Brave) run
      // in parallel in Rust. Typical 300–1500 ms. We catch and continue on
      // error: a resolver miss just means providers see the raw query.
      log("engine", `resolving: "${qnRaw}"`);
      try {
        resolved = await resolveQuery(query_);
        log(
          "engine",
          `resolved → ${resolved.intent} (${resolved.elapsed_ms}ms, ${resolved.candidates.length} candidates)`,
        );
      } catch (e) {
        log("engine", `resolve failed: ${e?.message ?? e}`);
      }
    } else {
      log("engine", `resolver skipped (literal-string search)`);
    }

    // Providers receive the canonical pair when available. Empty title
    // means the resolver pinned an artist-only canonical (e.g. a Genius
    // "X Lyrics, Songs, and Albums" page) — pass just the artist name so
    // providers return the discography instead of nothing.
    //
    // Genius titles often carry a parenthetical translation
    // ("Сукины дети (Sons of Bitches)") that is useful for display but
    // murders substring search on torrent/slsk filenames — peers don't
    // include translations in their file names. Strip bracket content
    // before handing the query off.
    const stripBrackets = (s) =>
      String(s ?? "")
        .replace(/\([^()]*\)/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();

    let providerQ;
    if (!resolved?.canonical) {
      providerQ = query_;
    } else if (!resolved.canonical.title) {
      providerQ = stripBrackets(resolved.canonical.artist);
    } else {
      providerQ = `${stripBrackets(resolved.canonical.artist)} ${stripBrackets(resolved.canonical.title)}`.trim();
    }

    log(
      "engine",
      `new session: providerQ="${providerQ}" [${enabledKinds.join(",")}]`,
    );
    const providers = enabledKinds.map((k) => registry[k]);
    const session = new SearchSession(providerQ, {
      providers,
      pipeline: defaultPipeline(),
      log,
      resolved,
      rawQuery: query_,
    });
    if (!opts.skipResolver) cache.set(cacheKey, session);
    return session;
  }

  return {
    query,
    /** Drop all cached sessions (use on logout / mirror switch). */
    clearCache: () => cache.clear(),
    /** Read-only view of the registry — do not mutate. */
    providers: registry,
  };
}
