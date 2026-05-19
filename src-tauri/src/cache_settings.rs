use std::path::Path;

use serde::{Deserialize, Serialize};

/// Default upper bound for the streaming cache folder (bytes).
pub const DEFAULT_STREAM_CACHE_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// Default TTL for idle torrents (seconds).
pub const DEFAULT_STREAM_CACHE_TTL_SECS: u64 = 3600;

const MIN_STREAM_CACHE_MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_STREAM_CACHE_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

const MIN_STREAM_CACHE_TTL_SECS: u64 = 5 * 60;
const MAX_STREAM_CACHE_TTL_SECS: u64 = 14 * 24 * 3600;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserCacheSettings {
    pub stream_cache_max_bytes: u64,
    pub stream_cache_ttl_secs: u64,
}

impl Default for UserCacheSettings {
    fn default() -> Self {
        Self {
            stream_cache_max_bytes: DEFAULT_STREAM_CACHE_MAX_BYTES,
            stream_cache_ttl_secs: DEFAULT_STREAM_CACHE_TTL_SECS,
        }
    }
}

impl UserCacheSettings {
    /// Loads settings from disk, or returns defaults if missing or invalid.
    pub fn load_from_disk(path: &Path) -> Self {
        let raw = std::fs::read_to_string(path).ok();
        let Some(text) = raw else {
            return Self::default();
        };
        serde_json::from_str::<Self>(&text)
            .ok()
            .filter(|s| s.validate().is_ok())
            .unwrap_or_default()
    }

    /// Checks bounds for max size and TTL.
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_STREAM_CACHE_MAX_BYTES..=MAX_STREAM_CACHE_MAX_BYTES)
            .contains(&self.stream_cache_max_bytes)
        {
            return Err(format!(
                "Лимит кэша стриминга: от {} до {} МиБ",
                MIN_STREAM_CACHE_MAX_BYTES / (1024 * 1024),
                MAX_STREAM_CACHE_MAX_BYTES / (1024 * 1024)
            ));
        }
        if !(MIN_STREAM_CACHE_TTL_SECS..=MAX_STREAM_CACHE_TTL_SECS)
            .contains(&self.stream_cache_ttl_secs)
        {
            return Err(format!(
                "TTL: от {} до {} минут",
                MIN_STREAM_CACHE_TTL_SECS / 60,
                MAX_STREAM_CACHE_TTL_SECS / 60
            ));
        }
        Ok(())
    }

    /// Persists settings next to other app data files.
    pub fn save_to_disk(&self, path: &Path) -> Result<(), String> {
        self.validate()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Не удалось создать каталог настроек: {e}"))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Сериализация настроек: {e}"))?;
        std::fs::write(path, json).map_err(|e| format!("Запись настроек кэша: {e}"))?;
        Ok(())
    }
}

