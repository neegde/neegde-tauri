/**
 * Global entity types — used across the whole app, not just search.
 *
 * Three user-facing units:
 *   - `Track`    — a single audio file, playable
 *   - `Album`    — a release (RuTracker folder OR SoulSeek folder) with tracks
 *   - `Playlist` — user-defined ordered list of tracks (same shape concept as Album but NOT tied to a source)
 *
 * Hierarchy is expressed by ids, not nesting:
 *   Album.trackIds: string[]       → children
 *   Track.albumId: string | null   → back-reference
 *   Playlist.trackIds: string[]
 *
 * Every Track / Album carries `sources[]` — origin + the refs the
 * player/downloader needs. Playlists have no source (user-created).
 */

// ── Source identity ──────────────────────────────────────────────────────────

/**
 * @typedef {"rutracker" | "soulseek"} ProviderKind
 */

/**
 * Identity inside a source that lets us actually play or download.
 * Shapes differ per provider — fields are optional; consumers check `kind`.
 *
 * @typedef {Object} SourceRefs
 * @property {string}  [topicId]        RuTracker topic (both Track and Album)
 * @property {number}  [fileIdx]        RuTracker: file index inside topic (Track only)
 * @property {string}  [rootPath]       RuTracker: dirPath from detectAlbums (Album only)
 * @property {string}  [slskUsername]   SoulSeek peer owning the file / folder
 * @property {string}  [slskFilepath]   SoulSeek: file path on that peer (Track only)
 * @property {string}  [slskFolder]     SoulSeek: folder path on that peer (Album only)
 */

/**
 * One origin of an entity — a single listing from a single provider.
 *
 * @typedef {Object} SourceRef
 * @property {ProviderKind} kind
 * @property {SourceRefs}   refs
 * @property {*}            raw   Original provider payload (engine-internal).
 */

// ── Entities ────────────────────────────────────────────────────────────────

/**
 * One audio file. May be a child of an `Album` (set `albumId`) or stand
 * alone ("orphan track" — a SoulSeek single, a lone file in a torrent).
 *
 * @typedef {Object} Track
 * @property {"track"}  type
 * @property {string}   id
 * @property {string}   title
 * @property {string|null} artist
 * @property {string|null} albumTitle   Display fallback when no parent Album is in scope.
 * @property {string}   fileName        Basename, preserved for legacy UIs.
 * @property {string|null} format       "FLAC" | "MP3" | ...
 * @property {number|null} bitrate      kbps
 * @property {number|null} duration     seconds
 * @property {number|null} size         bytes
 * @property {string|null} coverUrl     When known inline (RT). SLSK lazy-fetched via refs.
 *
 * @property {string|null}  albumId     parent Album entity id, if present
 *
 * @property {SourceRef[]}  sources
 * @property {number}       score
 * @property {number}       mergedFrom
 */

/**
 * A release. Owns an ordered list of Track ids.
 *
 * @typedef {Object} Album
 * @property {"album"}  type
 * @property {string}   id
 * @property {string}   title
 * @property {string|null} artist
 * @property {number|null} year
 * @property {string|null} coverUrl
 * @property {string|null} format       Aggregated across tracks.
 * @property {number|null} bitrate      Best across tracks.
 * @property {number|null} size         Sum of tracks.
 * @property {number|null} seeders      RuTracker only
 * @property {number|null} leechers     RuTracker only
 * @property {number|null} peers        SoulSeek only — distinct peers holding a matching copy
 *
 * @property {string[]}     trackIds    Ordered children.
 *
 * @property {SourceRef[]}  sources
 * @property {number}       score
 * @property {number}       mergedFrom
 */

/**
 * User-defined ordered list of tracks. Shape-wise similar to `Album`
 * but has no `sources` (it's not a release from any provider — it's a
 * collection curated by the user). Stored in local storage.
 *
 * @typedef {Object} Playlist
 * @property {"playlist"} type
 * @property {string}  id            Stable local id (UUID-ish)
 * @property {string}  title         User-chosen name
 * @property {string|null} coverUrl  User-assigned or derived; null = auto (e.g. first track cover)
 * @property {number}  createdAt     ms epoch
 * @property {number}  updatedAt     ms epoch
 * @property {string[]} trackIds     Ordered Track ids. (Actual Track bodies stored separately.)
 */

/**
 * Any top-level entity the UI can render or the player can consume.
 * @typedef {Track | Album | Playlist} Entity
 */

// ── Resolver / search-specific types (kept here until the resolver gets its own file) ──

/**
 * Context passed to provider.search().
 *
 * @typedef {Object} SearchContext
 * @property {AbortSignal} signal
 * @property {(tag: string, msg: string) => void} log
 * @property {number} requestId
 */

/**
 * @typedef {Object} SearchProvider
 * @property {ProviderKind} kind
 * @property {(query: string, ctx: SearchContext) => AsyncIterable<(Track | Album)[]>} search
 */

/**
 * @typedef {"pending" | "streaming" | "done" | "error" | "skipped"} ProviderRunStatus
 */

/**
 * @typedef {"idle" | "resolving" | "streaming" | "done" | "error" | "cancelled"} SessionStatus
 */

export {};
