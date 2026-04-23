/**
 * Unified cover resolution for a Track or Album entity.
 *
 * Reading the result *inside a Vue computed / watchEffect* makes it reactive —
 * the underlying caches (`rutracker/coverCache`, `soulseek/coverCache`) expose
 * reactive Maps, so a fresh fetch auto-updates consumers.
 *
 * Lookup order for a Track:
 *   1. `track.coverUrl`            — inline (RT TorrentDetails bakes this in)
 *   2. SoulSeek: parent Album's `sources[0].raw.cover`, else track's own ref
 *   3. RuTracker: topicId → legacy topic-cover cache
 *
 * For Albums the same logic applies to the Album's own `sources[0]`.
 */

import { getCoverReactive } from "../rutracker/coverCache.js";
import { getSlskCoverReactive, getSlskCoverDataUrl, peekSlskCover } from "../soulseek/coverCache.js";
import { getRutrackerCoverDataUrl, peekRutrackerCover } from "../rutracker/coverCache.js";
import { getAlbum, entitiesVersion } from "../stores/entities.js";

/** @typedef {import("../types/entities.js").Track | import("../types/entities.js").Album} Entity */

/**
 * Current cover URL for an entity, reading from reactive caches.
 * Returns an empty string when nothing is available yet.
 *
 * @param {Entity | null} entity
 * @returns {string | null}
 */
export function coverUrlOf(entity) {
  if (!entity) return null;
  // Subscribe to entity-registry mutations so re-registers (e.g. an Album
  // getting its `.coverUrl` stamped later) refresh consumers.
  entitiesVersion.value;

  if (entity.coverUrl) return entity.coverUrl;

  const src = entity.sources?.[0];
  if (!src) return null;

  if (src.kind === "soulseek") return slskCoverFor(entity);
  if (src.kind === "rutracker") return rtCoverFor(entity);
  return null;
}

/**
 * Kick the lazy-fetch side of cover loading. Call from an IntersectionObserver
 * when the card enters the viewport. Noop when the cover is already cached
 * (positive or in-flight) or when the entity has no loadable source.
 *
 * @param {Entity} entity
 */
export function startLazyCoverFetch(entity) {
  if (!entity || entity.coverUrl) return;
  const src = entity.sources?.[0];
  if (!src) return;

  if (src.kind === "soulseek") {
    const c = slskCoverRef(entity);
    if (!c?.slsk_username || !c?.slsk_filepath) return;
    if (peekSlskCover(c.slsk_username, c.slsk_filepath) !== undefined) return;
    void getSlskCoverDataUrl(c.slsk_username, c.slsk_filepath, c.size ?? 0).catch(() => {});
    return;
  }

  if (src.kind === "rutracker") {
    const topicId = src.refs?.topicId;
    if (!topicId) return;
    if (peekRutrackerCover(String(topicId)) !== undefined) return;
    void getRutrackerCoverDataUrl(String(topicId)).catch(() => {});
  }
}

// ── Per-source helpers ─────────────────────────────────────────────────────

function slskCoverFor(entity) {
  const c = slskCoverRef(entity);
  if (!c?.slsk_username || !c?.slsk_filepath) return null;
  return getSlskCoverReactive(c.slsk_username, c.slsk_filepath);
}

/** Finds the best SLSK cover ref for a Track (via parent Album) or Album. */
function slskCoverRef(entity) {
  const self = entity.sources?.[0]?.raw?.cover;
  if (self) return self;
  // Track nested in an album — pull the parent's cover ref.
  if (entity.type === "track" && entity.albumId) {
    const parent = getAlbum(entity.albumId);
    const pc = parent?.sources?.[0]?.raw?.cover;
    if (pc) return pc;
  }
  return null;
}

function rtCoverFor(entity) {
  const topicId = entity.sources?.[0]?.refs?.topicId;
  if (!topicId) return null;
  return getCoverReactive(String(topicId));
}
