//! Thin proxy for the Deezer public-search API.
//!
//! Lives in Rust rather than in the webview because WKWebView returns a
//! generic "Load failed" for outbound fetches to `api.deezer.com` on
//! macOS (ATS / sandbox quirk). reqwest from the Rust side has no such
//! constraints and gets straightforward JSON back.
//!
//! Input: a free-form `q=` expression (the frontend crafts `artist:"X"
//! track:"Y"` or similar). Output: the raw JSON string so the frontend
//! can parse with its existing types.

use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

/// Shared HTTP client. OnceLock-initialised because this module has no
/// managed-state hook and rebuilding a client per call would trash
/// connection pooling.
fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent("neegde/1.0")
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .pool_max_idle_per_host(4)
            .build()
            .expect("failed to build deezer reqwest client")
    })
}

#[tauri::command]
pub async fn deezer_search(query: String, limit: u32) -> Result<String, String> {
    let limit = limit.clamp(1, 25);
    let r = client()
        .get("https://api.deezer.com/search")
        .query(&[("q", query.as_str()), ("limit", &limit.to_string())])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("deezer: request failed: {e}"))?;
    let status = r.status();
    if !status.is_success() {
        return Err(format!("deezer: http {status}"));
    }
    r.text().await.map_err(|e| format!("deezer: body read: {e}"))
}
