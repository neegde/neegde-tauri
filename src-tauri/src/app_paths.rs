//! Canonical on-disk layout for application data.
//!
//! Every path the app reads from or writes to should go through this module
//! so the directory structure is defined in one place.
//!
//! ```text
//! {app_data_dir}/
//!   rutracker/
//!     session.json          cookie jar
//!     meta.json             username / avatar / mirror
//!     proxy.txt             HTTP proxy URL
//!     covers/               disk cover-art cache
//!     webview/              WebView2 data dir (login window)
//!   soulseek/
//!     creds.json            login credentials
//!     covers/               disk cover-art cache
//!   bt/                     (dev builds: dev/bt/)
//!     torrent/              librqbit streaming session
//!     covers/               librqbit cover-art session
//!     vozduxan/             vozduxan C++ session
//!   cache_settings.json
//!   app_debug.json
//!   general-list.json
//!   dev/
//!     bt/torrent|covers|vozduxan/   dev-build streaming sessions
//!     dumps/                        debug dump snapshots
//! ```

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn base(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))
}

// ── RuTracker ─────────────────────────────────────────────────────────────────

pub fn rt_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base(app)?.join("rutracker"))
}

pub fn rt_session_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(rt_dir(app)?.join("session.json"))
}

pub fn rt_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(rt_dir(app)?.join("meta.json"))
}

pub fn rt_proxy_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(rt_dir(app)?.join("proxy.txt"))
}

pub fn rt_covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(rt_dir(app)?.join("covers"))
}

pub fn rt_webview_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(rt_dir(app)?.join("webview"))
}

// ── SoulSeek ──────────────────────────────────────────────────────────────────

pub fn slsk_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base(app)?.join("soulseek"))
}

pub fn slsk_creds_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(slsk_dir(app)?.join("creds.json"))
}

pub fn slsk_covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(slsk_dir(app)?.join("covers"))
}

// ── BitTorrent streaming sessions ─────────────────────────────────────────────
//
// Debug builds use dev/bt/ so development sessions stay separate from the
// production data; both can coexist on the same machine.

pub fn bt_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let b = base(app)?;
    Ok(if cfg!(debug_assertions) {
        b.join("dev").join("bt")
    } else {
        b.join("bt")
    })
}

pub fn bt_torrent_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bt_base_dir(app)?.join("torrent"))
}

pub fn bt_covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bt_base_dir(app)?.join("covers"))
}

pub fn bt_vozduxan_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bt_base_dir(app)?.join("vozduxan"))
}

// ── Developer tooling ─────────────────────────────────────────────────────────

pub fn dev_dumps_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base(app)?.join("dev").join("dumps"))
}

// ── Top-level config files ────────────────────────────────────────────────────

pub fn cache_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base(app)?.join("cache_settings.json"))
}

pub fn app_debug_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base(app)?.join("app_debug.json"))
}

pub fn general_list_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base(app)?.join("general-list.json"))
}
