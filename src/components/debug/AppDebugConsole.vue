<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const lines = ref([]);
const collapsed = ref(false);
const bodyRef = ref(null);
const logText = computed(() => lines.value.map(formatLine).join("\n"));
let unlisten = null;

function formatLine(l) {
  const ms = typeof l.tsMs === "number" ? l.tsMs : 0;
  const t = new Date(ms).toISOString().slice(11, 23);
  const d = l.detail != null ? ` ${JSON.stringify(l.detail)}` : "";
  return `[${t}] [${l.category}] ${l.message}${d}`;
}

async function refreshFromRust() {
  const snap = await invoke("get_app_debug_log");
  lines.value = Array.isArray(snap) ? snap : [];
}

async function clearLog() {
  await invoke("clear_app_debug_log");
  lines.value = [];
}

async function copyAll() {
  const text = lines.value.map(formatLine).join("\n");
  await navigator.clipboard.writeText(text);
}

function scrollToBottom() {
  nextTick(() => {
    const el = bodyRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

onMounted(async () => {
  await refreshFromRust();
  unlisten = await listen("app-debug-line", (ev) => {
    const p = ev.payload;
    lines.value = [...lines.value, p].slice(-2500);
    if (!collapsed.value) scrollToBottom();
  });
});

onUnmounted(() => {
  if (typeof unlisten === "function") unlisten();
});

watch(collapsed, (c) => {
  if (!c) scrollToBottom();
});

watch(lines, () => {
  if (!collapsed.value) scrollToBottom();
}, { deep: true });
</script>

<template>
  <div class="app-debug-console" :class="{ 'app-debug-console--collapsed': collapsed }">
    <div class="app-debug-toolbar">
      <span class="app-debug-title">Журнал отладки</span>
      <span class="app-debug-count">{{ lines.length }} строк</span>
      <div class="app-debug-actions">
        <button type="button" class="app-debug-btn" @click="refreshFromRust">Обновить</button>
        <button type="button" class="app-debug-btn" @click="copyAll">Копировать</button>
        <button type="button" class="app-debug-btn app-debug-btn--danger" @click="clearLog">
          Очистить буфер
        </button>
        <button
          type="button"
          class="app-debug-btn app-debug-btn--collapse"
          :title="collapsed ? 'Развернуть' : 'Свернуть'"
          @click="collapsed = !collapsed"
        >
          {{ collapsed ? "▲" : "▼" }}
        </button>
      </div>
    </div>
    <div
      v-show="!collapsed"
      ref="bodyRef"
      class="app-debug-body"
      role="log"
      aria-live="polite"
    >
      <pre class="app-debug-pre">{{ logText }}</pre>
    </div>
  </div>
</template>

<style scoped>
.app-debug-console {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  background: var(--bg-elevated, #1a1a1e);
}

.app-debug-console--collapsed {
  flex: 0 0 auto;
}

.app-debug-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--bg-muted, #222);
  border-bottom: 1px solid var(--border, #333);
}

.app-debug-title {
  font-weight: 600;
  color: var(--text, #eee);
}

.app-debug-count {
  color: var(--text-muted, #888);
  font-variant-numeric: tabular-nums;
}

.app-debug-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.app-debug-btn {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid var(--border, #444);
  background: var(--bg, #18181c);
  color: var(--text, #ddd);
  cursor: pointer;
}

.app-debug-btn:hover {
  filter: brightness(1.08);
}

.app-debug-btn--danger {
  border-color: #633;
  color: #faa;
}

.app-debug-btn--collapse {
  min-width: 32px;
  padding-inline: 8px;
}

.app-debug-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.app-debug-pre {
  margin: 0;
  padding: 8px 10px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  line-height: 1.45;
  color: var(--text, #e8e8ec);
}
</style>
