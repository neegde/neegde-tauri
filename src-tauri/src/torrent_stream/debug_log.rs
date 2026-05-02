use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

const DEFAULT_MAX_LINES: usize = 2500;

/// One line in the application debug console (shown in the UI).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugLine {
    pub ts_ms: u64,
    pub category: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

/// Ring buffer + live `app-debug-line` events (streaming, UI, and other subsystems).
pub struct AppDebugLog {
    app: AppHandle,
    enabled: AtomicBool,
    lines: Mutex<VecDeque<DebugLine>>,
    max_lines: usize,
}

impl AppDebugLog {
    /// Creates a new log sink; `enabled` starts false until loaded from disk or toggled in UI.
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            enabled: AtomicBool::new(false),
            lines: Mutex::new(VecDeque::new()),
            max_lines: DEFAULT_MAX_LINES,
        })
    }

    /// Sets whether new lines are recorded and emitted.
    pub fn set_enabled(&self, v: bool) {
        self.enabled.store(v, Ordering::SeqCst);
    }

    /// Returns the current toggle (for commands).
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Appends a line unconditionally; also emits `app-debug-line` for live UI.
    /// `is_enabled` no longer gates writes — logs are always captured so errors
    /// are visible even when the debug window was never manually opened.
    pub fn push(
        &self,
        category: impl Into<String>,
        message: impl Into<String>,
        detail: Option<serde_json::Value>,
    ) {
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let line = DebugLine {
            ts_ms,
            category: category.into(),
            message: message.into(),
            detail,
        };
        {
            let mut q = self.lines.lock().unwrap();
            while q.len() >= self.max_lines {
                q.pop_front();
            }
            q.push_back(line.clone());
        }
        let _ = self.app.emit("app-debug-line", &line);
    }

    /// Returns a copy of the buffer (newest at the end).
    pub fn snapshot(&self) -> Vec<DebugLine> {
        self.lines.lock().unwrap().iter().cloned().collect()
    }

    /// Clears the in-memory buffer (does not change `enabled`).
    pub fn clear_buffer(&self) {
        self.lines.lock().unwrap().clear();
    }
}
