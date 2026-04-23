<script setup>
import { computed } from "vue";

const props = defineProps({
  /** True while the Rust resolver is running for the current query. */
  resolving: { type: Boolean, default: false },
  /**
   * Resolver output for the currently-displayed search, or null.
   * Shape matches `ResolveResult` from src/search/resolver.js.
   */
  resolved: { type: Object, default: null },
});

const emit = defineEmits([
  /** User asked to search the literal string instead of the resolver's canonical pair. */
  "revert-to-raw",
]);

const hasCanonical = computed(() => Boolean(props.resolved?.canonical?.artist));
const isArtistCanonical = computed(
  () => Boolean(props.resolved?.canonical?.artist) && !props.resolved?.canonical?.title,
);

const intentLabel = computed(() => {
  switch (props.resolved?.intent) {
    case "track":  return "Трек";
    case "artist": return "Исполнитель";
    case "album":  return "Альбом";
    case "lyric":  return "Текст песни";
    case "raw":    return "Как есть";
    default:       return "";
  }
});

const sourcesText = computed(() => {
  const top = props.resolved?.candidates?.[0];
  return (top?.sources ?? []).join(", ");
});

/** Debug-only: up to 4 alternative candidates besides the canonical one. */
const alternatives = computed(() => (props.resolved?.candidates ?? []).slice(1, 5));
</script>

<template src="./SearchIntentHint.html"></template>

<style scoped src="./SearchIntentHint.scoped.css"></style>

