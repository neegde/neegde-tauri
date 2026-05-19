# neegde-tauri

Tauri 2 desktop music player for RuTracker + SoulSeek streaming.
Frontend: Vue 3 + Vite + TypeScript. Backend: Rust + C++ (vozduxan).

## Dev workflow

```
cargo tauri dev          # starts Vite + Tauri in watch mode
cargo tauri build        # release bundle (.app + .dmg on macOS)
cargo check              # Rust-only type check (fast)
```

Build artefact: `src-tauri/target/{debug,release}/neegde`.
The `cmake` crate rebuilds `libvozduxan.a` when C++ sources change; `build.rs`
enumerates individual C++ files via `cargo:rerun-if-changed` because macOS does
not bump the directory mtime when a file inside it changes.

## Repository layout

```
src/                              Vue 3 frontend (TS)
  App.vue / App.html              Top-level shell, queue, navigation
  main.ts                         Mounts App / AppDebugWindow / PlayerVizStandalone
  torrent/api.ts                  streamUrl(), prefetchNextInQueue()
  torrent/torrentSession.ts       releaseTorrentStreamUrl()
  soulseek/                       Soulseek client API wrappers
  rutracker/                      Rutracker auth, search, sessions
  search/                         Search engine (sessions, providers, pipeline, resolver bridge)
    engine.ts                     createSearchEngine() — provider registry + cache
    session.ts                    SearchSession (per-query, streaming rows)
    resolver.ts                   thin wrapper around the Rust resolver command
    pipeline/                     normalize / filter / dedup / score stages
    providers/                    rutracker.ts, soulseek.ts adapters
  components/
    player/Player.vue             Audio element, stream status popup
    search/                       SearchBar, Results, intent hint, slsk row
    torrent/                      Torrent detail + track list
    debug/AppDebugConsole.vue     Ring-buffer view (orphan UI — see below)
  composables/                    useAppDebug, usePrefetch, useStreamReadiness, …
  stores/                         Queue, likes, playlists, entities (persisted)
  persistence/
    generalList.ts                Debug track registry — records every seen track
    generalListCacheProbe.ts      Pure cache probe helpers (no circular deps)

src-tauri/
  build.rs                        Builds vozduxan via cmake
  src/app_paths.rs                Canonical data-dir layout — all paths go through here
  src/lib.rs                      Tauri setup, managed state, invoke_handler list
  src/vozduxan_ffi.rs             Raw unsafe C bindings to vozduxan
  src/vozduxan_stream.rs          Safe Rust wrapper + streaming Tauri commands
  src/torrent_stream/             Legacy librqbit path (export + debug log sink)
    debug_log.rs                  AppDebugLog — ring buffer + Tauri event emitter
    debug_api.rs                  get/set/clear debug log, app_debug_push
    export.rs                     torrent_export_files / _cancel
  src/resolver/                   Query intent resolver (see below)
    mod.rs                        orchestrator, ranking, canonical pick
    sources/brave.rs              Brave Search + Argon2id PoW challenge solver
    norm.rs / types.rs            normalization + public DTOs
  src/soulseek/                   Full SoulSeek stack (login, search, stream)
  src/rutracker/                  Rutracker HTTP/session/cover
  src/torrent_image.rs            Cover-art via transient librqbit fetches (bt/covers/)
  src/cache_commands.rs           User-facing cache settings / purge
  src/general_list.rs             general_list_write / general_list_path / factory_reset
  src/nerd_stats.rs               Diagnostics panel data
```

## Data directory layout

All paths are centralised in `src-tauri/src/app_paths.rs`.

```
{app_data_dir}/
  rutracker/session.json, meta.json, proxy.txt, covers/, webview/
  soulseek/creds.json, covers/
  bt/torrent/, bt/covers/, bt/vozduxan/   (debug builds: dev/bt/…)
  cache_settings.json
  app_debug.json
  general-list.json                       debug track registry (every seen track)
  dev/dumps/                              dev-only search dump snapshots
```

Never hardcode a path string in a Rust module — add a helper to `app_paths.rs` instead.

## Streaming architecture

All playback uses **vozduxan** (C++ + libtorrent) or **SoulSeek P2P**.
The legacy `torrent_stream` module is kept only for full-download export
and for hosting the shared `AppDebugLog`.

### Token buckets (vozduxan_stream.rs)

`VozduxanSessionInner` tracks three token buckets:

| Bucket | Purpose | Evicts current? |
|---|---|---|
| `current_token` | Active playback stream | Yes (replaces old) |
| `prefetch_token` | Next-track look-ahead (track+1) | No |
| `warm_prefetch_token` | Second-ahead warm-up (track+2) | No |

`prefetch_next(warm_only: bool)` routes to either `prefetch_token` (real next)
or `warm_prefetch_token`. The warm bucket exists so a second-ahead warm-up
never evicts the real next-track prefetch.

### Tauri commands (vozduxan path)

```
torrent_prepare_stream          prepare + store in current_token
torrent_release_stream          release by token string
torrent_dispose_preview         release all tokens (cache purge only)
torrent_prepare_cancel          set prepare_cancelled flag
torrent_magnet_list_files       list files without starting playback
torrent_prefetch_next_track     prepare + store in prefetch_token or warm_prefetch_token
vozduxan_notify_position        forward byte offset to C++ priority worker
vozduxan_stream_stats           peer/bandwidth telemetry
```

### Debug logging

`AppDebugLog` (shared `Arc`) is created by `TorrentStreamState` and handed to
`VozduxanStreamState` and `TorrentImageState` so all three share a single sink.

- C++ logs: `VozduxanConfig.log_fn` → `on_vozduxan_log()` → `AppDebugLog.push()`.
- Rust logs: `self.dlog()` / `dlog` closures in `spawn_blocking`.
- Frontend logs: `appDebugLog()` → `app_debug_push` Tauri command → same sink.

**Stderr (`eprintln!` / C++ stderr) always receives all logs.**
`AppDebugLog` additionally keeps a ring buffer and emits a Tauri event for the
in-app console view.

**The in-app debug console has no settings UI anymore.** The toggle card was
removed; `AppDebugConsole.vue`, `AppDebugWindow.vue`, and `appDebugWindow.ts`
still exist and are mounted when the `?app-debug` window URL opens, but no
runtime path auto-opens that window except `App.vue`'s `import.meta.env.DEV`
branch (dev-only convenience). `useAppDebug.ts` no longer opens or closes the
window on `appDebugEnabled` changes — do not re-add that behavior.

## Search + resolver

Two-stage search pipeline:

1. **`resolver::resolve_query`** (Rust) — takes the raw user query and returns
   `{canonical, candidates, intent, elapsed_ms}`. The canonical `(artist, title)`
   is what providers actually search for; `intent` drives UI routing
   (Track / Artist / Album / Lyric / Raw).
2. **`SearchEngine` + providers** (frontend) — feeds the canonical string (or
   raw on `Raw`) to rutracker + soulseek in parallel, streams rows into a
   `SearchSession`, and runs them through the normalize/filter/dedup/score
   pipeline.

The resolver's fast tier is **Brave Search only** (site-restricted to
`genius.com`). iTunes and LRCLIB were dropped and their source files removed
(iTunes surfaced wrong tracks by global popularity; LRCLIB was network-blocked
for the user and always timed out). Brave returns 429 + a JSON Argon2id PoW
challenge when suspicious — `sources/brave.rs` solves it locally and retries.

Ranking is done in `resolver/mod.rs::match_score` and its callers. Known weak
spot: lyric-snippet queries where multiple candidates tie on 1.0 and stable
sort falls back to Brave's own order — see bug discussion in branch history.

## Key invariants

- `VozduxanStreamState::new()`, `TorrentImageState::new()`, and
  `TorrentStreamState` must share the same `Arc<AppDebugLog>` — a single log sink.
- `VozduxanConfig.log_userdata` points into the `Arc<AppDebugLog>` kept alive by
  `VozduxanSessionInner._debug_log_arc`. Do not drop the Arc before the session.
- The `torrent_stream::debug_log` submodule is `pub mod` (not `mod`) so
  `vozduxan_stream.rs` can import `AppDebugLog`.
- `cargo:rerun-if-changed` in `build.rs` enumerates individual C++ source files
  (directory mtime is not updated on macOS when a file inside changes).
- `metadata_received_alert` is NOT fired when `atp.ti` is already set.
  `vozduxan_stream_prepare` handles this case internally in C++; do not work
  around it on the Rust side.
- Resolver's Brave source enforces `site:genius.com` client-side too — Brave
  honours the operator loosely and still mixes YouTube / Apple Music / blog
  results; `brave.rs` drops anything whose page title doesn't end in `Genius`.
