# Refactor backlog — handoff for next session

**Дата паузы:** 2026-04-24
**Последний коммит:** `21` "#12 SearchProvider class"
**Ветка:** `feat/search-engine`

> Читай этот файл целиком, прежде чем продолжать. Затем жди инструкций
> от пользователя — можно подсказать «следующий пункт» из списка ниже.

---

## Где мы сейчас

### Покрытие (после коммита 17)

| Метрика | Текущее | Порог в `vitest.config.ts` |
|---|---|---|
| **Lines** | **94.02%** (4560/4850) | 92 |
| **Statements** | 91.55% (5250/5734) | 90 |
| **Functions** | 90.41% (1028/1137) | 89 |
| **Branches** | 77.67% (3000/3862) | 75 |

**Тесты: 1376 passing / 111 files.** Зелёные, `vue-tsc --noEmit` чист.

Файлы всё ещё под 90% Lines (работа для докрутки):
- `Player.vue` — 77.87%
- `useTorrentDetail.ts` — 80.87%
- `TorrentView.vue` — 83.73%
- `PlaylistView.vue` — 84.21%
- `App.vue` — 88.36%
- `SettingsView.vue` — 88.04%
- `TrackCover.vue` — 88.88%
- `Album.ts` — 89.47%

### История коммитов (последние для ориентации)

```
df026a3 17  — Player reads stores directly (HIGH #9)
80cb07a 16  — useTrackContextMenu composable (HIGH #8)
2ef9762 15  — useTorrentDetail composable (HIGH #7, App.vue 1416→1145)
4ab9faf 14  — MediaSessionManager (HIGH #6)
863b04a 13  — Unified CoverCache<K> (HIGH #5)
2545e18 12  — Playlist + Library classes (HIGH #4)
be3333a 11  — PlaybackQueue class (HIGH #3)
c2c4b04 10  — Album class hierarchy + useEntityCover consolidated (HIGH #1, #2)
d352d79 9   — dead code cleanup (App.vue −136)
6960322 7   — 90% coverage push
ec86c97 6   — первая итерация тестов
c53a538 5   — миграция всех .js → .ts
...
```

### Все 9 HIGH-пунктов аудита ✅ завершены

1. ✅ Album class hierarchy (RutrackerAlbum, SoulseekAlbum, factory)
2. ✅ Consolidate useEntityCover (убрали `if (src.kind === ...)` ветки)
3. ✅ PlaybackQueue class (state-machine с инвариантами внутри)
4. ✅ Playlist class + Library manager
5. ✅ Unified CoverCache&lt;K&gt; (torrent теперь использует shared core)
6. ✅ MediaSessionManager class
7. ✅ useTorrentDetail composable (350 строк из App.vue)
8. ✅ useTrackContextMenu (дедуп 90 строк между 3 views)
9. ✅ Player читает stores напрямую (убрали 11 props)

---

## Что осталось — MEDIUM / LOW

### MEDIUM (вероятно следующий батч)

- ~~**#10 `NavigationTarget` полиморфный**~~ ✅ commit 20 — discriminated union `RutrackerNavigationTarget | SoulseekNavigationTarget`. SLSK target теперь только `{source, slskUsername, slskFilepath}`, RT/magnet несёт torrentId/magnet/fileIdx/albumDirPath. `handleOpenTorrentFromPlayer` в App.vue и `handleOpenTorrentSourceFromView` в useTorrentDetail ветвятся по `source` сразу. Тесты обновлены.

- ~~**#11 Типизированные `.raw` аксессоры**~~ ✅ commit 19 — `TrackSource` теперь кэнд-generic в `raw`, `SoulseekTrack.getCoverRef()` / `getPeers()` публичны, RutrackerTrack использует `rtRaw?.details?.magnet`. Обновлены SlskTrackRow, Results.

- ~~**#12 `SearchProvider` class**~~ ✅ commit 21 — `SearchProvider` теперь abstract class в `src/search/provider.ts` с `protected log(ctx, msg)` helper'ом. `RutrackerProvider` / `SoulseekProvider` extends SearchProvider, используют `this.log(ctx, ...)` вместо `ctx.log("rutracker", ...)`. Session.ts ре-экспортит типы. Тест session.test.ts: FakeProvider extends SearchProvider.

- **#13 `LikesCollection` class** — 3 Maps/Sets (`likedTrackIds`, `likedAlbumIds`, `likedAt`) сейчас синкаются вручную в `toggleLikeTrack`/`toggleLikeAlbum`. Объединить в один `{ entityId → { likedAt } }`. Blast: ~10 сайтов.

- **#14 `TrackCache` class** — `persistence/trackCache.ts` сейчас модуль с singleton-style functions. Сделать class с eviction policy + типизированным API. Blast: ~28 сайтов.

- **#15 `AuthManager` + `AuthProvider`** — RT + SLSK auth живут раздельно. Абстракция для будущих провайдеров. Blast: ~11 сайтов.

- **#16 `RateLimitedFetchQueue<T>`** — `audio/metadataEnrich.ts` и `audio/coverFetch.ts` дублируют паттерн throttle+queue (MusicBrainz 1.05s, iTunes 1.1s). Выделить в class. Blast: 4 сайта.

- **#17 `StreamingExporter` class** — `torrent/torrentExport.ts` имеет 3 функции с ~70% одинаковой логики (dialog → listen → invoke → finally). Blast: 6 сайтов.

- **#18 `Equalizer` class (объединить config + state + graph)** — сейчас 3 связанных модуля: `audio/equalizerConfig.ts`, `audio/equalizerState.ts`, `audio/equalizerGraph.ts`. Blast: 3 сайта. Осторожно с Vue-idiomatic refs.

- **#19 `usePlaylistCrud` + `useSearchUI` composables** — из App.vue (80 + 200 строк). Snippet для playlist: `handleCreate/Delete/Rename/AddTrack` + `playlistModal`, `playlistTrack` state. Для searchUI: `searchQuery`, `homeSearchActive`, `slskPeerBrowseUser`, `handleSearch`, `handleRevertToRaw`. Blast: много биндингов в App.html.

- **#20 Слить `useBufferPoll`/`useBufferingWatchdog`/`useStreamStats`/`useStreamStatus`** → `useStreamReadiness` — все 4 composables в Player наблюдают одни и те же refs (streamPhase, prepareProgress, stats). Цель: объединить ~300 строк в один композабл с когерентными выходами.

### LOW (косметика / future-proofing)

- **PipelineStage class** (search/pipeline/) — сейчас plain functions. OK как есть.
- **`BoundedHistory<T>`** — `lib/recentHistory.ts` + `lib/searchHistory.ts` дублируют load/add/remove. Generic helper.
- **`AchievementsTracker` class** — легковесный рефактор ergonomics.
- **`StreamingSearch<T>`** — abstract over SLSK event-driven batching.
- **`VisualizerPreset` abstract** — 4 draw functions в `visualizerPresets.ts`. Нужно только если добавляем много пресетов.
- **`useTrackRowActions` helper** — после #8 (context menu), ещё раз в 3 view'ах повторяется вычисление `canPlay/canDownload/sourceLabel`.
- **`useDownloadProgress` composable** — 45 строк в App.vue для логгинга прогресса.
- **Упростить useNavStack** — 15 refs в ctx, Heavyweight API. Осторожно, работает.
- **Унификация нейминга событий** — mix `@play` vs `@play-track`, `@toggle-like` vs `@toggle-like-track`. Style-guide enforcement.

---

## Что остаётся в coverage exclude (намеренно)

Эти модули не тестируются в jsdom — помечены в `vitest.config.ts`:

- Entry points: `main.ts`, `appDebugWindow.ts`, `AppDebugWindow.vue`, `appDebugLog.ts`, `playerVizWindow.ts`, `PlayerVizStandalone.vue`
- Canvas / WebGL / Audio graph: `visualizerDrawFrame.ts`, `visualizerBroadcast.ts`, `equalizerGraph.ts`, `equalizerConfig.ts`, `equalizerState.ts`, `visualizerPresets.ts`, `PlayerVisualizerModal.vue`
- IPC-wrapper composables: `usePlayerEqualizer`, `useStreamStats`, `useStreamStatus`, `useBufferPoll`, `useBufferingWatchdog`, `useDiscordPresence`, `useMarquee`
- `mockData.ts`, `torrentExport.ts`, `torrentSession.ts`

---

## Архитектурные инварианты (НЕ ломать)

1. **Track / Album hierarchy** в `src/track/` и `src/album/` — единственный канонический way работы с сущностями. Данные боундари → `buildTrack(data)` / `buildAlbum(data)`. Нет `if (kind === ...)` snippets вне factory.ts.

2. **`entities.ts` = единственный registry**. Все Track/Album лукапы через `getTrack(id)` / `getAlbum(id)`. `registerEntity` гидрирует raw data автоматически.

3. **`PlaybackQueue` (singleton) = единственный owner queue state**. `queueIds`, `queuePos`, `repeatMode`, `shuffleOn`, `suppressAutoplay`, `nowPlayingTrack`, `next`, `secondNext`, `hasPrev`, `hasNext`, `tracks` (Track[]) все отсюда. Все мутаторы — методы класса; модульные exports — тонкие делегаты.

4. **`Library` (singleton)** — playlists. Playlist instance-ы (class) с инвариантами (`addTrack`/`removeTrack`/`reorderTracks`/`rename` возвращают bool на "изменилось ли").

5. **`makeCoverCache()` factory** из `lib/coverCacheCore.ts` — единственная реализация reactive + LRU + negative-TTL + concurrency gating. RT, SLSK, torrent — все через неё.

6. **`MediaSessionManager` (singleton)** — атомарный install/clear, защита от "partially installed" состояний.

7. **`Player.vue` читает stores напрямую** — не принимает props. `App.vue` только слушает эмиты.

8. **`useTorrentDetail` composable** — owner торрент/альбом-detail state. Не дублировать state refs в App.vue.

---

## Команды для проверки

```bash
# Типы
npm run typecheck

# Все тесты
npm test -- --run

# С покрытием
npm test -- --coverage --run

# Один файл
npx vitest run tests/album/Album.test.ts
```

## Нейминг коммитов

Коммиты нумеруются целыми числами начиная с 1. Последний — **21**. Следующий должен быть **22**.

HEREDOC-стиль:

```bash
git commit -m "$(cat <<'EOF'
18

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Стейджить всё (включая coverage/ — она идёт в git по convention этого репозитория):

```bash
git add -A src/ tests/ coverage/ vitest.config.ts
```

---

## Рекомендуемый порядок атаки MEDIUM-блока

**Пакет A (domain-чистка):**
1. #10 NavigationTarget полиморфный → зависит от #11
2. #11 Типизированные `.raw` аксессоры
3. #12 SearchProvider class

**Пакет B (stores):**
4. #13 LikesCollection class
5. #14 TrackCache class
6. #15 AuthManager + AuthProvider

**Пакет C (infrastructure):**
7. #16 RateLimitedFetchQueue&lt;T&gt;
8. #17 StreamingExporter class
9. #18 Equalizer unified class (осторожно: в coverage exclude)

**Пакет D (UI):**
10. #19 usePlaylistCrud + useSearchUI composables
11. #20 useStreamReadiness (слияние 4 composables)

После каждого пункта: коммит с новым номером, запуск `npm test -- --coverage --run`, проверка что пороги всё ещё проходят. При росте покрытия — поднимать пороги в `vitest.config.ts`.

---

## Открытые задачи в TaskList

- **#74 pending**: "Coverage review + gap-fill to 98%" — остался от прежней сессии, сейчас частично реализован (94% lines). Можно закрыть как "superseded" или оставить как северную звезду.
