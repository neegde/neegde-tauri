// Discord Rich Presence: set DISCORD_CLIENT_ID at compile time (Discord Developer Portal application ID).
// Optional: DISCORD_PRESENCE_BUTTON_URL=https://… (empty = no button; unset = https://neegde.ru).

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::Deserialize;
use std::sync::Mutex;
use tauri::State;

/// Application ID from the Discord Developer Portal. Empty disables Rich Presence.
const CLIENT_ID: &str = match option_env!("DISCORD_CLIENT_ID") {
    Some(s) if !s.is_empty() => s,
    _ => "",
};

const LISTEN_BUTTON_LABEL: &str = "Слушать нигде";

fn listen_on_neegde_button_url() -> Option<&'static str> {
    match option_env!("DISCORD_PRESENCE_BUTTON_URL") {
        Some(s) if s.is_empty() => None,
        Some(s) => Some(s),
        None => Some("https://neegde.ru"),
    }
}

/// Shared mutex around an optional [`DiscordIpcClient`].
pub struct DiscordPresenceState(pub Mutex<Option<DiscordIpcClient>>);

impl DiscordPresenceState {
    /// Creates a new `DiscordPresenceState` with no IPC connection yet.
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPresencePayload {
    pub title: String,
    pub subtitle: String,
    pub playing: bool,
    pub position_sec: Option<f64>,
    pub duration_sec: Option<f64>,
}

fn clamp_chars(s: &str, max_chars: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max_chars {
        return t.to_string();
    }
    t.chars().take(max_chars).collect()
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn build_activity(input: &DiscordPresencePayload) -> activity::Activity<'static> {
    let title = clamp_chars(&input.title, 128);
    let subtitle = clamp_chars(&input.subtitle, 128);

    let mut a = activity::Activity::new()
        .activity_type(activity::ActivityType::Listening)
        .status_display_type(activity::StatusDisplayType::Details);

    if !title.is_empty() {
        a = a.details(title);
        if !subtitle.is_empty() {
            a = a.state(subtitle);
        }
    } else if !subtitle.is_empty() {
        a = a.details(subtitle);
    }

    if input.playing {
        let dur = input.duration_sec.filter(|x| x.is_finite() && *x > 0.0);
        let pos = input.position_sec.filter(|x| x.is_finite() && *x >= 0.0);
        if let (Some(dur), Some(pos)) = (dur, pos) {
            let pos_clamped = pos.min(dur);
            let now = now_unix_ms();
            let pos_ms = (pos_clamped * 1000.0) as i64;
            let dur_ms = (dur * 1000.0) as i64;
            let start = now - pos_ms;
            let end = start + dur_ms;
            a = a.timestamps(activity::Timestamps::new().start(start).end(end));
        }
    }

    if let Some(url) = listen_on_neegde_button_url() {
        a = a.buttons(vec![activity::Button::new(LISTEN_BUTTON_LABEL, url)]);
    }

    a
}

fn ensure_client(guard: &mut Option<DiscordIpcClient>) -> Option<&mut DiscordIpcClient> {
    if CLIENT_ID.is_empty() {
        return None;
    }
    if guard.is_none() {
        let mut c = DiscordIpcClient::new(CLIENT_ID);
        if c.connect().is_err() {
            return None;
        }
        *guard = Some(c);
    }
    guard.as_mut()
}

/// Updates Rich Presence from the current track.
///
/// Args:
///     state: Managed Discord IPC state.
///     payload: Title, subtitle, playback flag, and optional position/duration for the time bar.
///
/// Errors:
///     String error if the presence mutex is poisoned.
#[tauri::command]
pub fn discord_presence_sync(
    state: State<'_, DiscordPresenceState>,
    payload: DiscordPresencePayload,
) -> Result<(), String> {
    if CLIENT_ID.is_empty() {
        return Ok(());
    }

    if !payload.playing {
        return discord_presence_clear(state);
    }

    let mut guard = state.0.lock().map_err(|_| "discord presence lock poisoned".to_string())?;
    let Some(client) = ensure_client(&mut guard) else {
        return Ok(());
    };

    let activity = build_activity(&payload);
    if client.set_activity(activity).is_err() {
        let _ = client.close();
        *guard = None;
    }
    Ok(())
}

/// Clears Rich Presence in Discord.
///
/// Args:
///     state: Managed Discord IPC state.
///
/// Errors:
///     String error if the presence mutex is poisoned.
#[tauri::command]
pub fn discord_presence_clear(state: State<'_, DiscordPresenceState>) -> Result<(), String> {
    if CLIENT_ID.is_empty() {
        return Ok(());
    }

    let mut guard = state.0.lock().map_err(|_| "discord presence lock poisoned".to_string())?;
    let Some(client) = guard.as_mut() else {
        return Ok(());
    };
    if client.clear_activity().is_err() {
        let _ = client.close();
        *guard = None;
    }
    Ok(())
}

/// Clears activity and closes the IPC connection (intended for application exit).
///
/// Args:
///     state: Managed Discord IPC state.
pub fn discord_presence_shutdown(state: &DiscordPresenceState) {
    if CLIENT_ID.is_empty() {
        return;
    }
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    let Some(mut client) = guard.take() else {
        return;
    };
    let _ = client.clear_activity();
    let _ = client.close();
}
