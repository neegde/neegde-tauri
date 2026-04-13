# Где слушаешь? Нигде.

Десктопный музыкальный плеер, который стримит аудио напрямую из торрент-роёв. Не скачивает — играет. Никаких подписок, никаких серверов. Только BitTorrent и немного наглости.

Поиск через Rutracker. Стриминг через [vozduxan](https://github.com/neegde/vozduxan).

<p align="center"><video src="images/demo.mp4" controls playsinline width="720"></video></p>

---

## Возможности

### Стриминг без скачивания
Треки воспроизводятся прямо из торрент-роя по мере загрузки кусков. Не нужно ждать пока скачается — плеер получает данные в реальном времени через локальный HTTP-сервер с поддержкой Range-запросов, поэтому перемотка работает как обычно.

### Hover-prefetch
Когда наводишь курсор на трек, приложение начинает готовить стрим в фоне — ещё до клика. Когда нажимаешь play, буфер уже есть. Следующие два трека в очереди тоже пребуферируются заранее. Переключение между треками — мгновенное.

### Поиск
- Поиск по Rutracker с кэшем последних 30 запросов
- Авторизация через логин/пароль, сессия сохраняется между запусками
- Поддержка зеркал (rutracker.net, .org, .nl, .cr, .lib, maintracker.org) — авто или вручную
- HTTP-прокси (два встроенных пресета или свой)

### Плеер
- Очередь треков с восстановлением позиции после перезапуска
- Перемотка, громкость, предыдущий/следующий
- 10-полосный графический эквалайзер (32 Гц — 16 кГц, ±12 дБ) с 10 пресетами и своими настройками
- Media Session API — управление через системные медиа-кнопки и экран блокировки
- Discord Rich Presence — показывает что играет
- Кнопка лайка прямо в плеере

### Браузер раздач
- Список треков с форматом, размером, длительностью
- Группировка по альбомам, режимы отображения список/галерея
- Обложки с лайтбоксом
- Значки форматов (FLAC, MP3, OGG, WAV, …)

### Библиотека
Три раздела: Треки, Альбомы, Раздачи. Лайкнутое сохраняется локально — никаких аккаунтов.

### Экспорт
Скачать отдельный трек, альбом или всё из раздачи в выбранную папку — с прогрессом и сохранением структуры папок.

### Настройки и кэш
- Максимальный размер кэша (50–8192 МиБ) и TTL (5 мин–14 дней)
- Очистка кэша стримов и обложек
- Тёмная / светлая / системная тема
- Дебаг-консоль с фильтрами и экспортом лога
- Диагностика: память, пути, размеры кэшей, активные стримы

---

## Установка

Скачай последний релиз под свою платформу на [странице релизов](https://github.com/neegde/neegde-tauri/releases).

Для работы нужен аккаунт на Rutracker.

---

## Обратная связь

Баги и предложения — в [Issues](https://github.com/neegde/neegde-tauri/issues) или в [тгк](https://t.me/youthcode).

---
---

## For developers

### Stack

| Layer | Tech |
|-------|------|
| Frontend | Vue 3 (Composition API, `<script setup>`) + Vite 6 |
| Desktop shell | Tauri 2 |
| Rust backend | reqwest, tokio, serde |
| Streaming engine | [vozduxan](https://github.com/neegde/vozduxan) — C++ static lib wrapping libtorrent-rasterbar |

No UI frameworks — all styles are hand-written CSS with dark/light theme via CSS variables.

### Project layout

```
src/
  App.vue                   top-level: all view state, queue, hover-prefetch coordination
  style.css                 CSS variables (dark/light theme)
  components/
    player/Player.vue       audio element, EQ graph, media session, stream status popup
    search/                 SearchBar, Results grid, AlbumCard
    torrent/TorrentView.vue tracklist, album grouping, hover-prefetch event emitter
    likes/LikesView.vue     liked tracks / albums / torrents tabs
    settings/SettingsView.vue
    shell/                  NavArrows, AppAuthPanel, DownloadProgressOverlay
    shared/                 CoverThumb, CoverLightbox, PlayingIndicator
    debug/AppDebugConsole.vue
  torrent/
    api.js                  streamUrl(), hoverStreamUrl(), prefetchNextInQueue()
    torrentSession.js       Tauri invoke wrappers, vozduxanNotifyPosition()
  audio/
    equalizerGraph.js       Web Audio API: 10 BiquadFilterNode chain
    equalizerState.js       gain state + localStorage persistence
    equalizerConfig.js      preset definitions
  rutracker/                auth, search, cover cache, mirror/proxy config
  library/                  likes storage, likesCover

src-tauri/src/
  lib.rs                    Tauri setup, managed state, invoke_handler
  vozduxan_ffi.rs           raw unsafe C bindings to vozduxan
  vozduxan_stream.rs        safe Rust wrapper + all streaming Tauri commands
  rutracker/                Rust HTTP login (CP1251), search, torrent topic parser
  torrent_stream/           legacy full-download/export path (librqbit)
    export.rs               torrent_export_files + progress events
    debug_log.rs            AppDebugLog — ring buffer + Tauri event emitter
  cover_art.rs              MusicBrainz + CoverArtArchive fallback
  torrent_image.rs          separate librqbit session for cover image downloading
  nerd_stats.rs             memory/cache diagnostics Tauri command
```

### Streaming architecture

All playback goes through **vozduxan** (C++ + libtorrent). The legacy `torrent_stream` module is kept only for full-download export.

vozduxan lives as a git submodule at `vozduxan/` and is compiled by the `cmake` crate in `build.rs`. No pre-built binaries — everything builds from source.

**Token buckets** in `vozduxan_stream.rs`:

| Bucket | Purpose | Releases current stream? |
|--------|---------|--------------------------|
| `current_token` | active playback | yes — replaces old on new track |
| `prefetch_token` | next-queue look-ahead | no |
| `hover_token` | hover-prefetch | never — released on mouse-leave |

Hover path: `torrent_hover_prepare_stream` → `hover_token`.  
On click: `torrent_hover_activate` promotes `hover_token → current_token`.  
On mouse-leave: `torrent_hover_release_stream`.

### Running locally

```bash
# Prerequisites: Node 20+, Rust stable, CMake 3.20+, libtorrent-rasterbar

# macOS
brew install libtorrent-rasterbar

# Ubuntu
sudo apt-get install libtorrent-rasterbar-dev cmake

# Clone with submodules
git clone --recurse-submodules https://github.com/neegde/neegde-tauri.git
cd neegde-tauri
npm install
cargo tauri dev
```

Fast Rust-only type check: `cargo check`

### Tauri commands (vozduxan path)

```
torrent_prepare_stream          prepare + store in current_token
torrent_release_stream          release by token string
torrent_dispose_preview         release all tokens (cache purge)
torrent_prepare_cancel          set prepare_cancelled flag
vozduxan_notify_position        forward byte offset to C++ priority worker
torrent_prefetch_next_track     prepare + store in prefetch_token
torrent_hover_prepare_stream    prepare + store in hover_token
torrent_hover_release_stream    release hover_token
torrent_hover_activate          promote hover_token → current_token
```

### Key invariants

- Never call `torrent_prepare_stream` for hover-prefetch — it stores in `current_token` and gets killed by the next track
- Always call `torrent_hover_activate` before assigning the hover URL to `<audio src>`
- `VozduxanStreamState::new()` must receive the same `Arc<AppDebugLog>` as `TorrentStreamState`
- `cargo:rerun-if-changed` in `build.rs` enumerates individual C++ source files — directory mtime is not updated on macOS when a file inside changes
