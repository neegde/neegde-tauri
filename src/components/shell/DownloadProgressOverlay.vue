<script setup>
import { computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

const props = defineProps({
  /** null — скрыто */
  progress: { type: Object, default: null },
});

/** Развёрнутое модальное окно (false = компактная кнопка в углу). */
const expanded = defineModel("expanded", { type: Boolean, default: true });

const hasProgress = computed(() => props.progress != null);
const showModal = computed(() => hasProgress.value && expanded.value);
const showDock = computed(() => hasProgress.value && !expanded.value);

const phaseLabel = computed(() => {
  const p = props.progress?.phase;
  if (p === "preparing") return "Подготовка";
  if (p === "downloading") return "Загрузка";
  if (p === "copying") return "Сохранение";
  if (p === "done") return "Готово";
  if (p === "cancelled") return "Остановлено";
  return "Скачивание";
});

const isCancelled = computed(() => props.progress?.phase === "cancelled");

const canStop = computed(() => {
  const p = props.progress?.phase;
  return !!p && p !== "done" && p !== "cancelled";
});

/** Общий прогресс по очереди треков (последовательная загрузка). */
const overallPct = computed(() => {
  const p = props.progress;
  if (!p) return 0;
  const bt = p.batchTotal;
  if (!bt || bt < 2) {
    return Math.min(100, Math.max(0, p.pct ?? 0));
  }
  const bi = Math.max(0, (p.batchIndex ?? 1) - 1);
  const slice = (p.pct ?? 0) / 100 / bt;
  return Math.min(100, (bi / bt + slice) * 100);
});

const barPct = computed(() => {
  const p = props.progress;
  if (!p) return 0;
  if (p.phase === "copying" && p.copyTotal > 0 && p.copyIndex != null) {
    return Math.min(100, (p.copyIndex / p.copyTotal) * 100);
  }
  if (p.batchTotal > 1 && (p.phase === "downloading" || p.phase === "preparing")) {
    return overallPct.value;
  }
  return Math.min(100, Math.max(0, p.pct ?? 0));
});

const barIndeterminate = computed(() => props.progress?.phase === "preparing");

const fmtBytes = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} Б`;
  const u = ["КБ", "МБ", "ГБ", "ТБ"];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

function minimize() {
  expanded.value = false;
}

function expand() {
  expanded.value = true;
}

async function requestStop() {
  if (!canStop.value) return;
  // IPC invoke can queue behind the long export call — emit reaches Rust immediately.
  await emit("torrent-export-cancel-request", {});
  try { await invoke("torrent_export_cancel"); } catch (_) {}
  try { await invoke("soulseek_export_cancel"); } catch (_) {}
}
</script>

<template>
  <!-- Компактная кнопка при сворачивании -->
  <Teleport to="body">
    <Transition name="dl-dock">
      <div v-if="showDock" class="dl-dock-wrap">
        <button
          type="button"
          class="dl-dock"
          title="Развернуть окно скачивания"
          @click="expand"
        >
          <span v-if="!isCancelled" class="dl-dock-spinner" aria-hidden="true" />
          <span class="dl-dock-text">Скачивание</span>
          <span v-if="progress?.batchTotal > 1" class="dl-dock-batch">
            {{ progress.batchIndex }}/{{ progress.batchTotal }}
          </span>
          <span class="dl-dock-pct">{{ Math.round(overallPct) }}%</span>
        </button>
        <button
          v-if="canStop"
          type="button"
          class="dl-dock-stop"
          title="Остановить скачивание"
          aria-label="Остановить"
          @click.stop="requestStop"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="1" />
          </svg>
        </button>
      </div>
    </Transition>
  </Teleport>

  <!-- Полноэкранный оверлей -->
  <Teleport to="body">
    <Transition name="dl-overlay">
      <div v-if="showModal" class="dl-overlay" role="dialog" aria-modal="true" aria-live="polite">
        <div class="dl-panel">
          <div class="dl-panel-head">
            <span v-if="!isCancelled" class="dl-spinner" aria-hidden="true" />
            <span class="dl-phase">{{ phaseLabel }}</span>
            <div class="dl-head-actions">
              <button
                v-if="canStop"
                type="button"
                class="dl-stop"
                title="Остановить скачивание"
                @click="requestStop"
              >
                Остановить
              </button>
              <button
                type="button"
                class="dl-minimize"
                aria-label="Свернуть"
                @click="minimize"
              >
                Свернуть
              </button>
            </div>
          </div>

          <p v-if="progress?.message" class="dl-msg">{{ progress.message }}</p>

          <div
            v-if="progress?.phase === 'downloading' || progress?.phase === 'preparing'"
            class="dl-bar-wrap"
            :class="{ 'dl-bar-wrap--pulse': barIndeterminate }"
          >
            <div
              class="dl-bar"
              :class="{ 'dl-bar--indet': barIndeterminate }"
              :style="barIndeterminate ? {} : { width: `${barPct}%` }"
            />
          </div>

          <div v-if="progress?.phase === 'downloading' && progress.totalBytes > 0" class="dl-bytes">
            {{ fmtBytes(progress.progressBytes) }} / {{ fmtBytes(progress.totalBytes) }}
            <span class="dl-pct">· {{ Math.round(progress.pct ?? 0) }}%</span>
            <template v-if="progress.batchTotal > 1">
              <span class="dl-pct"> · трек {{ progress.batchIndex }}/{{ progress.batchTotal }}</span>
            </template>
          </div>

          <div v-if="progress?.phase === 'copying'" class="dl-bar-wrap dl-bar-wrap--copy">
            <div class="dl-bar dl-bar--copy" :style="{ width: `${barPct}%` }" />
          </div>

          <p v-if="progress?.phase === 'copying' && progress.copyLabel" class="dl-copy-hint">
            {{ progress.copyIndex }} / {{ progress.copyTotal }} — {{ progress.copyLabel }}
          </p>

          <div v-if="progress?.queueLabels?.length" class="dl-queue">
            <div class="dl-queue-title">Очередь</div>
            <ul class="dl-queue-list">
              <li
                v-for="(label, i) in progress.queueLabels"
                :key="i"
                :class="['dl-queue-item', { 'dl-queue-item--done': progress.batchIndex != null && i < (progress.batchIndex - 1) && progress.phase !== 'preparing' }]"
              >
                <span class="dl-queue-idx">{{ i + 1 }}.</span>
                <span class="dl-queue-name" :title="label">{{ label }}</span>
              </li>
            </ul>
          </div>

          <p class="dl-hint">Треки качаются по одному: сначала загрузка, затем сохранение. BitTorrent зависит от сидов.</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dl-dock-wrap {
  position: fixed;
  bottom: calc(var(--player-h, 90px) + 16px);
  right: 20px;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dl-dock {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: var(--surface, #181818);
  color: var(--text, #fff);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  transition: transform 0.15s ease, background 0.15s ease;
}

.dl-dock:hover {
  background: var(--surface-h, #282828);
  transform: translateY(-1px);
}

.dl-dock-stop {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: var(--surface, #181818);
  color: var(--muted, #b3b3b3);
  cursor: pointer;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  transition: background 0.15s ease, color 0.15s ease;
}

.dl-dock-stop:hover {
  background: rgba(233, 20, 41, 0.15);
  color: var(--red, #e91429);
}

.dl-dock-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border, rgba(255, 255, 255, 0.12));
  border-top-color: var(--accent, #fc741d);
  border-radius: 50%;
  animation: dl-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.dl-dock-text {
  letter-spacing: -0.02em;
}

.dl-dock-batch {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted, #b3b3b3);
}

.dl-dock-pct {
  color: var(--accent, #fc741d);
  font-variant-numeric: tabular-nums;
}

.dl-dock-enter-active,
.dl-dock-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.dl-dock-enter-from,
.dl-dock-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

.dl-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
}

.dl-panel {
  width: min(420px, 100%);
  padding: 22px 22px 18px;
  border-radius: 12px;
  background: var(--surface, #181818);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
}

.dl-panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.dl-phase {
  flex: 1;
  min-width: 0;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.02em;
}

.dl-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dl-stop {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(233, 20, 41, 0.35);
  background: rgba(233, 20, 41, 0.1);
  color: var(--red, #e91429);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.dl-stop:hover {
  background: rgba(233, 20, 41, 0.2);
}

.dl-minimize {
  flex-shrink: 0;
  padding: 8px 14px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted, #b3b3b3);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.dl-minimize:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text, #fff);
  border-color: rgba(255, 255, 255, 0.2);
}

.dl-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border, rgba(255, 255, 255, 0.12));
  border-top-color: var(--accent, #fc741d);
  border-radius: 50%;
  animation: dl-spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes dl-spin {
  to {
    transform: rotate(360deg);
  }
}

.dl-msg {
  color: var(--muted, #b3b3b3);
  font-size: 13px;
  margin-bottom: 14px;
  line-height: 1.45;
}

.dl-bar-wrap {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  margin-bottom: 10px;
}

.dl-bar {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent, #fc741d), var(--accent-h, #ff9350));
  transition: width 0.25s ease-out;
}

.dl-bar-wrap--pulse {
  overflow: hidden;
}

.dl-bar--indet {
  width: 40% !important;
  animation: dl-indet 1.2s ease-in-out infinite;
}

@keyframes dl-indet {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(350%);
  }
}

.dl-bar-wrap--copy {
  margin-top: 4px;
}

.dl-bar--copy {
  background: linear-gradient(90deg, #3b82f6, #60a5fa);
}

.dl-bytes {
  font-size: 12px;
  color: var(--muted2, #535353);
  margin-bottom: 0;
}

.dl-pct {
  color: var(--muted, #b3b3b3);
}

.dl-copy-hint {
  font-size: 13px;
  color: var(--text, #fff);
  margin-top: 8px;
  word-break: break-word;
}

.dl-queue {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
}

.dl-queue-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted2, #535353);
  margin-bottom: 8px;
}

.dl-queue-list {
  list-style: none;
  max-height: 140px;
  overflow-y: auto;
  font-size: 12px;
}

.dl-queue-item {
  display: flex;
  gap: 6px;
  padding: 4px 0;
  color: var(--muted, #b3b3b3);
}

.dl-queue-item--done {
  opacity: 0.55;
}

.dl-queue-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-queue-idx {
  color: var(--muted2, #535353);
  flex-shrink: 0;
}

.dl-hint {
  margin-top: 14px;
  font-size: 11px;
  color: var(--muted2, #535353);
  line-height: 1.4;
}

.dl-overlay-enter-active,
.dl-overlay-leave-active {
  transition: opacity 0.2s ease;
}

.dl-overlay-enter-active .dl-panel,
.dl-overlay-leave-active .dl-panel {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.dl-overlay-enter-from,
.dl-overlay-leave-to {
  opacity: 0;
}

.dl-overlay-enter-from .dl-panel,
.dl-overlay-leave-to .dl-panel {
  transform: scale(0.96);
  opacity: 0;
}
</style>
