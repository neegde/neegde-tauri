<script setup>
import { ref, watch, onMounted, onUnmounted } from "vue";
import SystemIcon from "./SystemIcon.vue";

const props = defineProps({
  open: Boolean,
  src: { type: String, default: null },
  alt: { type: String, default: "" },
  /** Крупное окно (просмотр обложки альбома в раздаче). В остальных местах — компактно, как раньше. */
  large: { type: Boolean, default: false },
});

const emit = defineEmits(["update:open"]);

/**
 * Last non-empty `src` while the dialog is open. Parent `src` can briefly go empty
 * (e.g. torrent image cache eviction) after `open` is true; without this the overlay
 * unmounts and the enlarged view disappears.
 */
const lockedSrc = ref("");

watch(
  () => [props.open, props.src],
  ([open, src]) => {
    if (!open) {
      lockedSrc.value = "";
      return;
    }
    if (src) {
      lockedSrc.value = src;
    }
  },
  { immediate: true },
);

function close() {
  emit("update:open", false);
}

function onKeydown(e) {
  if (e.key === "Escape" && props.open) {
    e.preventDefault();
    close();
  }
}

watch(
  () => props.open,
  (v) => {
    if (typeof document === "undefined") return;
    document.documentElement.style.overflow = v ? "hidden" : "";
  }
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
  if (typeof document !== "undefined") {
    document.documentElement.style.overflow = "";
  }
});
</script>

<template src="./CoverLightbox.html"></template>

<style scoped src="./CoverLightbox.scoped.css"></style>

