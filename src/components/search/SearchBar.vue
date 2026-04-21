<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  loading: Boolean,
  showCategories: { type: Boolean, default: true },
  /** Recent query strings; when non-empty, dropdown can open on focus. */
  history: { type: Array, default: () => [] },
});

const emit = defineEmits(["search", "update:modelValue", "remove-history"]);

const CATS = [
  { id: "100", label: "Все" },
  { id: "101", label: "MP3" },
  { id: "104", label: "FLAC" },
];

const cat = ref("100");
const panelOpen = ref(false);
const rootRef = ref(null);

function submit(e) {
  e.preventDefault();
  panelOpen.value = false;
  emit("search", props.modelValue.trim(), cat.value);
}

function clear() {
  emit("update:modelValue", "");
  emit("search", "", cat.value);
}

/**
 * Opens the recent-queries panel when there is history.
 *
 * @returns {void}
 */
function openPanel() {
  if ((props.history?.length ?? 0) > 0) panelOpen.value = true;
}

/**
 * Closes the panel; used for outside click / escape.
 *
 * @returns {void}
 */
function closePanel() {
  panelOpen.value = false;
}

/**
 * @param {string} q
 * @returns {void}
 */
function pickQuery(q) {
  emit("update:modelValue", q);
  panelOpen.value = false;
  emit("search", q.trim(), cat.value);
}

/**
 * @param {string} q
 * @returns {void}
 */
function removeQuery(q) {
  emit("remove-history", q);
}

function onDocPointerDown(e) {
  const el = rootRef.value;
  if (!el?.contains(e.target)) closePanel();
}

function onKeydown(e) {
  if (e.code === "Escape") closePanel();
}

watch(
  () => props.history?.length ?? 0,
  (n) => {
    if (n === 0) panelOpen.value = false;
  },
);

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="rootRef" class="search-bar-root">
    <form class="search-form" @submit="submit">
      <div class="search-input-wrap">
        <span class="search-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
        </span>
        <input
          class="search-input"
          type="text"
          placeholder="Название группы или исполнителя…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :value="modelValue"
          @input="emit('update:modelValue', $event.target.value)"
          @focus="openPanel"
          @click="openPanel"
        />
        <button
          v-if="modelValue"
          type="button"
          class="search-clear-btn"
          title="Очистить"
          @click="clear"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <button class="search-btn" type="submit" :disabled="loading">
          <span v-if="loading" class="spinner" />
          <template v-else>Найти</template>
        </button>
      </div>
      <div v-if="showCategories" class="cat-tabs">
        <button
          v-for="c in CATS"
          :key="c.id"
          type="button"
          :class="['cat-tab', cat === c.id ? 'active' : '']"
          @click="cat = c.id"
        >
          {{ c.label }}
        </button>
      </div>
    </form>

    <Transition name="search-dd">
      <div
        v-if="panelOpen && history.length"
        class="search-history-dropdown"
        role="listbox"
        aria-label="Недавние запросы"
      >
        <div class="search-history-dropdown-label">Недавние запросы</div>
        <ul class="search-history-list search-history-list--dropdown" role="presentation">
          <li
            v-for="q in history"
            :key="q"
            class="search-history-item"
          >
            <button
              type="button"
              class="search-history-run"
              @mousedown.prevent="pickQuery(q)"
            >
              <svg
                class="search-history-run-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="12 8 12 12 14 14"/>
                <path d="M3.05 11A9 9 0 1 0 4 6.1"/>
                <polyline points="3 3 3 7 7 7"/>
              </svg>
              <span class="search-history-query-text">{{ q }}</span>
            </button>
            <button
              type="button"
              class="search-history-remove"
              title="Удалить из истории"
              aria-label="Удалить запрос из истории"
              @mousedown.prevent="removeQuery(q)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M18 6L6 18M6 6l12 12"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </li>
        </ul>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.search-bar-root {
  position: relative;
  width: 100%;
  z-index: 5;
}

.search-history-dropdown {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 50;
  max-height: min(55vh, 360px);
  overflow-y: auto;
  padding: 8px 0 10px;
  border-radius: 12px;
  background: var(--surface, #1e1c1a);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
}

.search-history-dropdown-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  padding: 4px 14px 8px;
}

.search-history-list--dropdown {
  gap: 2px;
}

.search-dd-enter-active,
.search-dd-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.search-dd-enter-from,
.search-dd-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
