# neegde-tauri

Tauri 2 desktop music player for RuTracker streaming.  
Frontend: Vue 3 + Vite. Backend: Rust + C++ (vozduxan).

## Dev workflow

```
cargo tauri dev          # starts Vite + Tauri in watch mode
cargo check              # Rust-only type check (fast)
```

Build artefact: `src-tauri/target/debug/neegde` (or release).  
The `cmake` crate rebuilds `libvozduxan.a` automatically when C++ source files change.

## Repository layout

```
src/                     Vue 3 frontend
  App.vue                Top-level: queue, hover-prefetch state, navigation
  torrent/api.js         streamUrl(), hoverStreamUrl(), prefetchNextInQueue()
  torrent/torrentSession.js  releaseTorrentStreamUrl(), hover*TorrentStreamUrl(), vozduxanNotifyPosition()
  components/player/Player.vue   Audio element, stream status popup
  components/torrent/TorrentView.vue  Track list, hover-track event emitter

src-tauri/
  build.rs               Builds vozduxan via cmake; enumerates C++ files for rerun-if-changed
  src/lib.rs             Tauri setup, managed state, invoke_handler registration
  src/vozduxan_ffi.rs    Raw unsafe C bindings to vozduxan
  src/vozduxan_stream.rs Safe Rust wrapper + all Tauri streaming commands
  src/torrent_stream/    Legacy librqbit path (export/full-download only)
    debug_log.rs         AppDebugLog — ring buffer + Tauri event emitter
    export.rs            torrent_export_files / torrent_export_cancel
```

## Streaming architecture

All playback uses **vozduxan** (C++ + libtorrent).  
The legacy `torrent_stream` module handles only full-download export.

### Token buckets (vozduxan_stream.rs)

`VozduxanSessionInner` tracks three token buckets:

| Bucket | Purpose | Releases current? |
|---|---|---|
| `current_token` | Active playback stream | Yes (replaces old) |
| `prefetch_token` | Next-queue look-ahead | No |
| `hover_token` | Hover-prefetch | **Never** |

Hover-prefetch uses `torrent_hover_prepare_stream` → stores in `hover_token`.  
When user clicks play → `torrent_hover_activate` promotes `hover_token → current_token`.  
When user leaves without clicking → `torrent_hover_release_stream`.

### Debug logging

`AppDebugLog` (shared `Arc`) is created by `TorrentStreamState` and passed to `VozduxanStreamState`.  
C++ logs flow through `VozduxanConfig.log_fn` → `on_vozduxan_log()` (in vozduxan_stream.rs) → `AppDebugLog.push()`.  
Rust wrapper logs call `self.dlog()` or a `dlog` closure in spawn_blocking.  
**Logs only appear in the in-app debug console when debug mode is enabled** (toggle in settings).  
Stderr (`eprintln!` / C++ stderr) always receives all logs regardless of debug mode.

### Tauri commands (vozduxan path)

```
torrent_prepare_stream          prepare + store in current_token
torrent_release_stream          release by token string
torrent_dispose_preview         release all tokens (cache purge only)
torrent_prepare_cancel          set prepare_cancelled flag
vozduxan_notify_position        forward byte offset to C++ priority worker
torrent_prefetch_next_track     prepare + store in prefetch_token
torrent_hover_prepare_stream    prepare + store in hover_token
torrent_hover_release_stream    release hover_token
torrent_hover_activate          promote hover_token → current_token
```

## Key invariants

- **Never call `torrent_prepare_stream` for hover-prefetch** — it would store the token in `current_token` and get killed by the next track's prepare.
- **Always call `torrent_hover_activate` before assigning the hover URL to `<audio src>`** — Player.vue does this in the hover-prefetch hit path.
- `VozduxanStreamState::new()` must receive the same `Arc<AppDebugLog>` as `TorrentStreamState` — both share a single log sink.
- `cargo:rerun-if-changed` in build.rs enumerates individual C++ source files (directory mtime is not updated on macOS when a file inside changes).

## Common gotchas

- `metadata_received_alert` is NOT fired when `atp.ti` is already set. The Rust wrapper calls `vozduxan_stream_prepare` which handles this internally in C++.
- The `torrent_stream` module's `debug_log` submodule is `pub mod` (not `mod`) so `vozduxan_stream.rs` can import `AppDebugLog`.
- `VozduxanConfig.log_userdata` points into the `Arc<AppDebugLog>` kept alive by `VozduxanSessionInner._debug_log_arc`. Do not drop the Arc before the session.
