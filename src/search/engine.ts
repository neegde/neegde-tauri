import { rutrackerProvider } from "./providers/rutracker.js";
import { soulseekProvider } from "./providers/soulseek.js";
import { SearchSession, type SearchProvider } from "./session.js";
import { SessionCache } from "./cache.js";
import { defaultPipeline } from "./pipeline/index.js";
import { resolveQuery, type ResolveResult } from "./resolver.js";

type LogFn = (tag: string, msg: string) => void;

export interface SearchEngineOptions {
  log?: LogFn;
  cacheMax?: number;
}

export interface SearchEngine {
  query: (
    rawQuery: string,
    enabled: Record<string, boolean>,
    opts?: { skipResolver?: boolean },
  ) => Promise<SearchSession>;
  clearCache: () => void;
  providers: Record<string, SearchProvider>;
}

function normalizeQuery(q: unknown): string {
  return String(q ?? "").trim().toLowerCase();
}

/**
 * Create the search engine. Exactly one instance per app session — it owns
 * the provider registry, the session cache, and the default pipeline.
 */
export function createSearchEngine(opts: SearchEngineOptions = {}): SearchEngine {
  const log: LogFn = opts.log ?? (() => {});
  const cache = new SessionCache<SearchSession>(opts.cacheMax ?? 30);

  const registry: Record<string, SearchProvider> = {
    rutracker: rutrackerProvider as SearchProvider,
    soulseek: soulseekProvider as SearchProvider,
  };

  async function query(
    rawQuery: string,
    enabled: Record<string, boolean>,
    queryOpts: { skipResolver?: boolean } = {},
  ): Promise<SearchSession> {
    const qnRaw = normalizeQuery(rawQuery);
    const enabledKinds = Object.keys(registry)
      .filter((k) => enabled?.[k])
      .sort();
    const cacheKey = `${qnRaw}|${enabledKinds.join(",")}`;

    if (!queryOpts.skipResolver) {
      const cached = cache.get(cacheKey);
      if (cached) {
        log("engine", `cache hit: "${qnRaw}" [${enabledKinds.join(",")}]`);
        return cached;
      }
    }

    if (!qnRaw) {
      return new SearchSession("", { providers: [], log });
    }

    let resolved: ResolveResult | null = null;
    if (!queryOpts.skipResolver) {
      log("engine", `resolving: "${qnRaw}"`);
      try {
        resolved = await resolveQuery(rawQuery);
        log(
          "engine",
          `resolved → ${resolved.intent} (${resolved.elapsed_ms}ms, ${resolved.candidates.length} candidates)`,
        );
      } catch (e) {
        const msg = (e as { message?: string })?.message ?? String(e);
        log("engine", `resolve failed: ${msg}`);
      }
    } else {
      log("engine", `resolver skipped (literal-string search)`);
    }

    const stripBrackets = (s: unknown): string =>
      String(s ?? "")
        .replace(/\([^()]*\)/g, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();

    let providerQ: string;
    if (!resolved?.canonical) {
      providerQ = rawQuery;
    } else if (!resolved.canonical.title) {
      providerQ = stripBrackets(resolved.canonical.artist);
    } else {
      providerQ = `${stripBrackets(resolved.canonical.artist)} ${stripBrackets(resolved.canonical.title)}`.trim();
    }

    log(
      "engine",
      `new session: providerQ="${providerQ}" [${enabledKinds.join(",")}]`,
    );
    const providers = enabledKinds.map((k) => registry[k]!);
    const session = new SearchSession(providerQ, {
      providers,
      pipeline: defaultPipeline(),
      log,
      resolved,
      rawQuery,
    });
    if (!queryOpts.skipResolver) cache.set(cacheKey, session);
    return session;
  }

  return {
    query,
    clearCache: () => cache.clear(),
    providers: registry,
  };
}
