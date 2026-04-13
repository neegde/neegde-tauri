<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import CoverThumb from "../shared/CoverThumb.vue";
import { prefetchTorrentDetails } from "../../rutracker/search.js";

const props = defineProps({
  recentHistory: { type: Array, default: () => [] },
  loggedIn: { type: Boolean, default: false },
});

const emit = defineEmits(["open-recent", "go-to-search", "search-query"]);

// ── Cover prefetch on auth ────────────────────────────────────────────────────
// IntersectionObserver fires before auth restores → rutracker_get_cover fails silently.
// Re-trigger when loggedIn becomes true.
watch(
  () => props.loggedIn,
  (on) => {
    if (!on) return;
    for (const item of props.recentHistory.slice(0, 10)) {
      if (item.source === "rutracker" && item.id) {
        prefetchTorrentDetails(item.id);
      }
    }
  },
  { immediate: true }
);

// ── Нерд-пульс ───────────────────────────────────────────────────────────────
const nerdStats = ref(null);
let nerdInterval = null;

async function fetchNerdStats() {
  try {
    nerdStats.value = await invoke("get_nerd_diagnostics");
  } catch {
    // no Tauri API (browser preview)
  }
}

onMounted(() => {
  fetchNerdStats();
  nerdInterval = setInterval(fetchNerdStats, 5000);
});

onUnmounted(() => {
  clearInterval(nerdInterval);
});

function fmtBytes(bytes) {
  if (bytes == null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const cachePercent = computed(() => {
  if (!nerdStats.value) return 0;
  const { streamCacheBytes, streamCacheLimitBytes } = nerdStats.value;
  if (!streamCacheLimitBytes) return 0;
  return Math.min(100, Math.round((streamCacheBytes / streamCacheLimitBytes) * 100));
});

// ── Monthly stats ─────────────────────────────────────────────────────────────
const thisMonthCount = computed(() => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return props.recentHistory.filter((item) => {
    const d = new Date(item.openedAt);
    return d.getFullYear() === year && d.getMonth() === month;
  }).length;
});

const MONTH_NAMES = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
];
const currentMonthName = computed(() => MONTH_NAMES[new Date().getMonth()]);

// ── Artist pills ──────────────────────────────────────────────────────────────
const topArtists = computed(() => {
  const freq = {};
  for (const item of props.recentHistory) {
    const a = item.artist?.trim();
    if (a) freq[a] = (freq[a] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name]) => name);
});

// ── Recent history ────────────────────────────────────────────────────────────
const recentSlice = computed(() => props.recentHistory.slice(0, 10));

const isEmpty = computed(() => !recentSlice.value.length);

function torrentDisplayName(name = "") {
  return name.replace(/^\([^)]+\)\s*/, "");
}
</script>

<template>
  <div class="home-view">

    <!-- Empty state -->
    <div v-if="isEmpty" class="home-empty">
      <div class="home-empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <p class="home-empty-title">Добро пожаловать в Neegde</p>
      <p class="home-empty-desc">
        Ищите музыку на Rutracker — она сразу начнёт играть через BitTorrent,<br>
        без ожидания и без скачивания на диск.
      </p>
      <button class="home-empty-btn" @click="emit('go-to-search')">Найти музыку</button>
    </div>

    <template v-else>

      <!-- ── Недавно слушал ──────────────────────────────────────────── -->
      <section class="home-section">
        <h2 class="home-section-title">Недавно слушал</h2>
        <div class="home-grid">
          <button
            v-for="item in recentSlice"
            :key="item.id"
            class="home-card"
            @click="emit('open-recent', item)"
          >
            <div class="home-card-cover">
              <CoverThumb
                :torrent-id="item.id"
                :source="item.source"
                :size="120"
                :radius="6"
                :fill="true"
              />
              <div class="home-card-play-overlay">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="7,4 21,12 7,20"/>
                </svg>
              </div>
            </div>
            <div class="home-card-name">{{ torrentDisplayName(item.name) }}</div>
            <div v-if="item.artist" class="home-card-sub">{{ item.artist }}</div>
          </button>
        </div>
      </section>

      <!-- ── Ваши исполнители ───────────────────────────────────────── -->
      <section v-if="topArtists.length" class="home-section">
        <h2 class="home-section-title">Ваши исполнители</h2>
        <div class="artist-pills">
          <button
            v-for="artist in topArtists"
            :key="artist"
            class="artist-pill"
            @click="emit('search-query', artist)"
          >
            {{ artist }}
          </button>
        </div>
      </section>

      <!-- ── Stats row ──────────────────────────────────────────────── -->
      <div class="stats-row">

        <!-- Monthly stats -->
        <section class="stat-card stat-month">
          <div class="stat-card-label">Активность</div>
          <div class="stat-month-sentence">
            В {{ currentMonthName }} вы открыли
            <strong>{{ thisMonthCount }}
            {{ thisMonthCount === 1 ? "раздачу" : thisMonthCount < 5 ? "раздачи" : "раздач" }}</strong>
            — {{ thisMonthCount === 0 ? "пора послушать что-нибудь" : thisMonthCount < 5 ? "неплохое начало" : thisMonthCount < 15 ? "так держать" : "настоящий меломан" }}
          </div>
          <div class="stat-month-hint">Раздача = альбом или сборник на Rutracker</div>
        </section>

        <!-- Нерд-пульс -->
        <section v-if="nerdStats" class="stat-card stat-nerd">
          <div class="stat-card-label">Нерд-пульс</div>
          <div class="nerd-grid">
            <div class="nerd-item">
              <span class="nerd-item-label">Потоки</span>
              <span class="nerd-item-value">{{ nerdStats.streamingTorrentCount }}</span>
            </div>
            <div class="nerd-item">
              <span class="nerd-item-label">Кэш</span>
              <span class="nerd-item-value">
                {{ fmtBytes(nerdStats.streamCacheBytes) }}
                <span class="nerd-item-dim">/ {{ fmtBytes(nerdStats.streamCacheLimitBytes) }}</span>
              </span>
            </div>
            <div class="nerd-item">
              <span class="nerd-item-label">Обложки</span>
              <span class="nerd-item-value">{{ fmtBytes(nerdStats.coverTorrentCacheBytes) }}</span>
            </div>
            <div class="nerd-item">
              <span class="nerd-item-label">ОЗУ</span>
              <span class="nerd-item-value">{{ fmtBytes(nerdStats.residentMemoryBytes) }}</span>
            </div>
          </div>
          <div class="cache-bar-wrap" :title="`${cachePercent}% кэша использовано`">
            <div class="cache-bar-fill" :style="{ width: cachePercent + '%' }" />
          </div>
        </section>

      </div>

    </template>
  </div>
</template>

<style scoped>
.home-view {
  padding: var(--main-pad-top) var(--main-pad-inline) 40px;
  min-height: 100%;
}

/* ── Empty state ── */
.home-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding-top: 80px;
  color: var(--muted);
  text-align: center;
}
.home-empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}
.home-empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.home-empty-desc {
  font-size: 14px;
  line-height: 1.6;
  margin: 0;
  max-width: 400px;
}
.home-empty-btn {
  margin-top: 8px;
  padding: 10px 24px;
  border-radius: 24px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: background 0.15s;
}
.home-empty-btn:hover {
  background: var(--accent-h);
}

/* ── Sections ── */
.home-section {
  margin-bottom: 36px;
}
.home-section-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 16px;
}

/* ── Cards grid ── */
.home-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
}
.home-card {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  border-radius: 8px;
  transition: background 0.15s;
}
.home-card:hover {
  background: var(--surface-h);
}
.home-card-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  background: var(--surface);
  margin-bottom: 8px;
}
.home-card-play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 0.15s;
  color: #fff;
}
.home-card:hover .home-card-play-overlay {
  opacity: 1;
}
.home-card-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  padding: 0 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-card-sub {
  font-size: 12px;
  color: var(--muted);
  padding: 2px 4px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Artist pills ── */
.artist-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.artist-pill {
  padding: 6px 14px;
  border-radius: 20px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.artist-pill:hover {
  background: var(--surface-h);
  border-color: var(--accent);
  color: var(--accent);
}

/* ── Stats row ── */
.stats-row {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 36px;
}

.stat-card {
  background: var(--surface);
  border-radius: 12px;
  padding: 20px 24px;
}
.stat-card-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: 8px;
}

/* Monthly card */
.stat-month {
  min-width: 200px;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.stat-month-sentence {
  font-size: 15px;
  color: var(--text);
  line-height: 1.5;
  margin-bottom: 6px;
}
.stat-month-sentence strong {
  color: var(--accent);
  font-weight: 700;
}
.stat-month-hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
}

/* Nerd pulse card */
.stat-nerd {
  flex: 1;
  min-width: 280px;
}
.nerd-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 24px;
  margin-bottom: 14px;
}
.nerd-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nerd-item-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.nerd-item-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.nerd-item-dim {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
}

/* Cache progress bar */
.cache-bar-wrap {
  height: 3px;
  background: var(--surface-h, rgba(255,255,255,0.08));
  border-radius: 2px;
  overflow: hidden;
  margin-top: 4px;
}
.cache-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.5s ease;
}
</style>
