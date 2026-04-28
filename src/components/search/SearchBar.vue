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

<template src="./SearchBar.html"></template>

<style scoped src="./SearchBar.scoped.css"></style>

