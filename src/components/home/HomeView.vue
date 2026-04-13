<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
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

const storySteps = [
  {
    title: "Нашли раздачу",
    caption: "Ищете альбом в каталоге Rutracker и открываете страницу раздачи.",
  },
  {
    title: "Выбираете трек",
    caption: "В списке файлов нажимаете нужный — приложение готовит поток.",
  },
  {
    title: "Пиры отдают куски",
    caption: "Клиент находит участников сети и получает фрагменты файла с разных машин.",
  },
  {
    title: "Буфер наполняется",
    caption: "Данные чуть забегают вперёд, чтобы звук шёл ровно, без пауз.",
  },
  {
    title: "Слушаете",
    caption: "Играет поток — целый альбом на диск качать не нужно.",
  },
];

const storyStep = ref(0);
const STORY_MS = 3200;
let storyTimerId = null;

onMounted(() => {
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  storyTimerId = window.setInterval(() => {
    storyStep.value = (storyStep.value + 1) % storySteps.length;
  }, STORY_MS);
});

onUnmounted(() => {
  if (storyTimerId != null) {
    window.clearInterval(storyTimerId);
    storyTimerId = null;
  }
});
</script>

<template>
  <div class="home-view">

    <!-- Empty state -->
    <div v-if="isEmpty" class="home-empty">
      <div class="home-empty-hero" aria-hidden="true">
        <div class="home-empty-disc">
          <span class="home-empty-disc-groove" />
          <span class="home-empty-disc-label" />
        </div>
        <div class="home-empty-waves">
          <span /><span /><span /><span /><span />
        </div>
      </div>
      <p class="home-empty-title">Добро пожаловать</p>
      <p class="home-empty-desc">
        Начните с поиска: выберите раздачу и нажмите воспроизведение.
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
      </div>

    </template>

    <section class="home-intro" aria-labelledby="home-intro-heading">
      <div class="home-intro-head">
        <h2 id="home-intro-heading" class="home-intro-title">Как это работает</h2>
        <p class="home-intro-lead">
          Простой рассказ по шагам: от поиска раздачи до звука в наушниках.
        </p>
      </div>

      <div class="home-unified">
        <div
          class="home-story-track"
          role="progressbar"
          :aria-valuenow="storyStep + 1"
          :aria-valuemin="1"
          :aria-valuemax="storySteps.length"
          aria-label="Прогресс подсказки"
        >
          <span
            class="home-story-track-fill"
            :style="{ width: ((100 * (storyStep + 1)) / storySteps.length) + '%' }"
          />
        </div>

        <div class="home-story-stage">
          <Transition name="home-story" mode="out-in">
            <div :key="storyStep" class="home-story-slide">
              <div class="home-story-fig" :class="'home-story-fig--' + storyStep" aria-hidden="true">
                <!-- 0: поиск + карточка -->
                <template v-if="storyStep === 0">
                  <div class="home-fig-search">
                    <span class="home-fig-lens" />
                    <span class="home-fig-handle" />
                  </div>
                  <div class="home-fig-album">
                    <span class="home-fig-album-dot" />
                    <span class="home-fig-album-lines" />
                  </div>
                </template>
                <!-- 1: список треков -->
                <template v-else-if="storyStep === 1">
                  <div class="home-fig-tracks">
                    <span class="home-fig-track" />
                    <span class="home-fig-track home-fig-track--on" />
                    <span class="home-fig-track" />
                  </div>
                </template>
                <!-- 2: пиры -->
                <template v-else-if="storyStep === 2">
                  <div class="home-fig-swarm">
                    <span class="home-fig-peer" />
                    <span class="home-fig-peer" />
                    <span class="home-fig-peer" />
                    <span class="home-fig-you">Вы</span>
                  </div>
                </template>
                <!-- 3: буфер -->
                <template v-else-if="storyStep === 3">
                  <div class="home-fig-buf">
                    <span class="home-fig-buf-label">буфер</span>
                    <div class="home-fig-buf-track">
                      <span class="home-fig-buf-fill" />
                    </div>
                  </div>
                </template>
                <!-- 4: звук -->
                <template v-else>
                  <div class="home-fig-sound">
                    <svg viewBox="0 0 64 56" fill="none" class="home-fig-speaker-svg">
                      <path
                        d="M12 18 H20 L28 12 V44 L20 38 H12 V18 Z"
                        fill="rgba(var(--accent-rgb), 0.12)"
                        stroke="var(--accent)"
                        stroke-width="2"
                        stroke-linejoin="round"
                      />
                      <path
                        class="home-fig-snd-w1"
                        d="M34 22 C38 26 38 30 34 34"
                        stroke="var(--accent)"
                        stroke-width="2"
                        stroke-linecap="round"
                      />
                      <path
                        class="home-fig-snd-w2"
                        d="M40 18 C46 24 46 32 40 38"
                        stroke="var(--accent-h)"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        opacity="0.9"
                      />
                    </svg>
                    <div class="home-fig-bars">
                      <span /><span /><span /><span />
                    </div>
                  </div>
                </template>
              </div>
              <h3 class="home-story-title">{{ storySteps[storyStep].title }}</h3>
              <p class="home-story-caption">{{ storySteps[storyStep].caption }}</p>
            </div>
          </Transition>
        </div>

        <div class="home-story-dots" role="tablist" aria-label="Шаги">
          <button
            v-for="(s, i) in storySteps"
            :key="i"
            type="button"
            role="tab"
            class="home-story-dot"
            :class="{ 'home-story-dot--active': i === storyStep }"
            :aria-selected="i === storyStep"
            :aria-label="`Шаг ${i + 1}: ${s.title}`"
            @click="storyStep = i"
          />
        </div>

        <p class="home-unified-foot">
          Очередь и эквалайзер хранятся только у вас на компьютере.
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-view {
  padding: var(--main-pad-top) var(--main-pad-inline) 40px;
  min-height: 100%;
}

/* ── How it works (bottom of page) ── */
.home-intro {
  margin-top: 40px;
  margin-bottom: 0;
  padding: 22px 22px 26px;
  border-radius: 16px;
  background:
    radial-gradient(ellipse 80% 60% at 50% -20%, rgba(var(--accent-rgb), 0.14), transparent 55%),
    var(--surface);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  overflow: hidden;
}
.home-intro-head {
  text-align: center;
  margin-bottom: 16px;
}
.home-intro-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 6px;
  letter-spacing: -0.02em;
}
.home-intro-lead {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--muted);
  max-width: 520px;
  margin-left: auto;
  margin-right: auto;
}

.home-unified {
  margin-top: 4px;
  padding: 14px 12px 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  max-width: 420px;
  margin-left: auto;
  margin-right: auto;
}

.home-story-track {
  height: 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.home-story-track-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, rgba(var(--accent-rgb), 0.65), var(--accent));
  transition: width 0.45s ease;
}

.home-story-stage {
  min-height: 128px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.home-story-enter-active,
.home-story-leave-active {
  transition: opacity 0.28s ease;
}
.home-story-enter-from,
.home-story-leave-to {
  opacity: 0;
}

.home-story-slide {
  width: 100%;
  text-align: center;
}

.home-story-fig {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  min-height: 88px;
  margin-bottom: 12px;
}

/* 0: поиск + плейсхолдер альбома */
.home-fig-search {
  position: relative;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
}
.home-fig-lens {
  position: absolute;
  left: 4px;
  top: 4px;
  width: 28px;
  height: 28px;
  border: 3px solid var(--accent);
  border-radius: 50%;
  opacity: 0.9;
  animation: home-fig-pulse 2s ease-in-out infinite;
}
.home-fig-handle {
  position: absolute;
  right: 4px;
  bottom: 6px;
  width: 16px;
  height: 4px;
  background: var(--accent-h);
  border-radius: 2px;
  transform: rotate(45deg);
  transform-origin: right center;
}
.home-fig-album {
  width: 72px;
  height: 56px;
  border-radius: 8px;
  background: linear-gradient(145deg, var(--surface-h), rgba(var(--accent-rgb), 0.12));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
}
.home-fig-album-dot {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: rgba(var(--accent-rgb), 0.35);
}
.home-fig-album-lines {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.12);
  box-shadow:
    0 8px 0 rgba(255, 255, 255, 0.06),
    0 16px 0 rgba(255, 255, 255, 0.04);
}

/* 1: список */
.home-fig-tracks {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: stretch;
  width: min(200px, 100%);
  margin: 0 auto;
}
.home-fig-track {
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
}
.home-fig-track--on {
  background: linear-gradient(90deg, rgba(var(--accent-rgb), 0.35), var(--accent));
  box-shadow: 0 0 12px rgba(var(--accent-rgb), 0.35);
  animation: home-fig-pulse 1.8s ease-in-out infinite;
}

/* 2: пиры → вы */
.home-fig-swarm {
  position: relative;
  width: 160px;
  height: 96px;
  margin: 0 auto;
}
.home-fig-swarm .home-fig-peer {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent-h);
  box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.4);
}
.home-fig-swarm .home-fig-peer:nth-child(1) {
  left: 50%;
  top: 4px;
  margin-left: -6px;
  animation: home-fig-peer 2.2s ease-in-out infinite;
}
.home-fig-swarm .home-fig-peer:nth-child(2) {
  left: 12px;
  bottom: 12px;
  background: #7ad69a;
  animation: home-fig-peer 2.2s ease-in-out infinite 0.25s;
}
.home-fig-swarm .home-fig-peer:nth-child(3) {
  right: 12px;
  bottom: 12px;
  background: #5fc9e8;
  animation: home-fig-peer 2.2s ease-in-out infinite 0.5s;
}
.home-fig-you {
  position: absolute;
  left: 50%;
  bottom: 0;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
  background: rgba(var(--accent-rgb), 0.2);
  border: 1px solid rgba(var(--accent-rgb), 0.45);
}
@keyframes home-fig-peer {
  0%, 100% {
    transform: translateY(0);
    opacity: 0.85;
  }
  50% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

/* 3: буфер */
.home-fig-buf {
  width: min(240px, 100%);
  margin: 0 auto;
}
.home-fig-buf-label {
  display: block;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted2);
  margin-bottom: 8px;
}
.home-fig-buf-track {
  height: 20px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  overflow: hidden;
}
.home-fig-buf-fill {
  display: block;
  height: 100%;
  width: 12%;
  border-radius: 7px;
  background: linear-gradient(90deg, rgba(var(--accent-rgb), 0.5), var(--accent));
  animation: home-fig-buf 2.6s ease-in-out infinite;
}
@keyframes home-fig-buf {
  0%, 100% {
    width: 14%;
  }
  45%, 55% {
    width: 92%;
  }
}

/* 4: звук */
.home-fig-sound {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 14px;
}
.home-fig-speaker-svg {
  width: 56px;
  height: auto;
  flex-shrink: 0;
}
.home-fig-snd-w1,
.home-fig-snd-w2 {
  animation: home-fig-snd 0.9s ease-in-out infinite;
}
.home-fig-snd-w2 {
  animation-delay: 0.12s;
}
@keyframes home-fig-snd {
  0%, 100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
.home-fig-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 40px;
}
.home-fig-bars span {
  width: 5px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--accent-h), var(--accent));
  animation: home-fig-bar 0.75s ease-in-out infinite;
}
.home-fig-bars span:nth-child(1) {
  height: 35%;
  animation-delay: 0s;
}
.home-fig-bars span:nth-child(2) {
  height: 65%;
  animation-delay: 0.08s;
}
.home-fig-bars span:nth-child(3) {
  height: 100%;
  animation-delay: 0.16s;
}
.home-fig-bars span:nth-child(4) {
  height: 50%;
  animation-delay: 0.24s;
}
@keyframes home-fig-bar {
  0%, 100% {
    transform: scaleY(0.45);
    opacity: 0.75;
  }
  50% {
    transform: scaleY(1);
    opacity: 1;
  }
}

@keyframes home-fig-pulse {
  0%, 100% {
    opacity: 0.85;
  }
  50% {
    opacity: 1;
  }
}

.home-story-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.02em;
}
.home-story-caption {
  margin: 0 auto;
  max-width: 340px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
}

.home-story-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
.home-story-dot {
  width: 8px;
  height: 8px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.2);
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}
.home-story-dot:hover {
  background: rgba(255, 255, 255, 0.35);
}
.home-story-dot--active {
  background: var(--accent);
  transform: scale(1.2);
}

.home-unified-foot {
  margin: 0;
  padding-top: 8px;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  font-size: 11px;
  line-height: 1.45;
  color: var(--muted2);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .home-story-track-fill {
    transition: none;
  }
  .home-fig-lens,
  .home-fig-track--on,
  .home-fig-peer,
  .home-fig-buf-fill,
  .home-fig-snd-w1,
  .home-fig-snd-w2,
  .home-fig-bars span {
    animation: none !important;
  }
  .home-fig-buf-fill {
    width: 72%;
  }
}

/* ── Empty state ── */
.home-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding-top: 36px;
  color: var(--muted);
  text-align: center;
}
.home-empty-hero {
  position: relative;
  width: min(280px, 90vw);
  height: 120px;
  margin-bottom: 8px;
}
.home-empty-disc {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 100px;
  height: 100px;
  border-radius: 50%;
  background: conic-gradient(
    from 200deg,
    var(--surface-h),
    rgba(var(--accent-rgb), 0.25),
    var(--surface-h)
  );
  box-shadow:
    inset 0 0 0 2px rgba(var(--accent-rgb), 0.25),
    0 12px 40px rgba(0, 0, 0, 0.35);
  animation: home-disc-spin 12s linear infinite;
}
.home-empty-disc-groove {
  position: absolute;
  inset: 10px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 6px rgba(0, 0, 0, 0.2);
}
.home-empty-disc-label {
  position: absolute;
  inset: 34px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #3a3530, #1a1816);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
@keyframes home-disc-spin {
  from {
    transform: translate(-50%, -50%) rotate(0deg);
  }
  to {
    transform: translate(-50%, -50%) rotate(360deg);
  }
}
.home-empty-waves {
  position: absolute;
  right: 0;
  bottom: 8px;
  display: flex;
  align-items: flex-end;
  gap: 5px;
  height: 48px;
}
.home-empty-waves span {
  width: 5px;
  border-radius: 3px;
  background: linear-gradient(180deg, var(--accent-h), var(--accent));
  animation: home-empty-wave 0.85s ease-in-out infinite;
}
.home-empty-waves span:nth-child(1) { height: 40%; animation-delay: 0s; }
.home-empty-waves span:nth-child(2) { height: 72%; animation-delay: 0.07s; }
.home-empty-waves span:nth-child(3) { height: 100%; animation-delay: 0.14s; }
.home-empty-waves span:nth-child(4) { height: 55%; animation-delay: 0.21s; }
.home-empty-waves span:nth-child(5) { height: 35%; animation-delay: 0.28s; }
@keyframes home-empty-wave {
  0%, 100% { transform: scaleY(0.5); opacity: 0.7; }
  50% { transform: scaleY(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .home-empty-disc {
    animation: none;
  }
  .home-empty-waves span {
    animation: none;
    transform: scaleY(0.75);
  }
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
</style>
