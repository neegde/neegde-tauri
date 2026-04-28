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
  /** Original user input (before resolver rewrote it). Shown on the "revert" button. */
  rawQuery: { type: String, default: "" },
});

const emit = defineEmits([
  "revert-to-raw",
  "search-candidate",
]);

const hasCanonical = computed(() => Boolean(props.resolved?.canonical?.artist));

function stripBrackets(s) {
  return String(s ?? "")
    .replace(/\([^()]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const canonicalArtist = computed(() =>
  stripBrackets(props.resolved?.canonical?.artist ?? ""),
);
const canonicalTitle = computed(() =>
  stripBrackets(props.resolved?.canonical?.title ?? ""),
);

const intentLabel = computed(() => {
  const i = props.resolved?.intent;
  if (i === "track") return "трек";
  if (i === "artist") return "исполнитель";
  if (i === "album") return "альбом";
  if (i === "lyric") return "по тексту";
  return "";
});

const topCandidates = computed(() => {
  const cands = props.resolved?.candidates ?? [];
  const a = canonicalArtist.value.toLowerCase();
  const t = canonicalTitle.value.toLowerCase();
  return cands
    .filter((c) => {
      const ca = stripBrackets(c.artist ?? "").toLowerCase();
      const ct = stripBrackets(c.title ?? "").toLowerCase();
      return !(ca === a && ct === t);
    })
    .slice(0, 3)
    .map((c) => ({
      artist: stripBrackets(c.artist ?? ""),
      title: stripBrackets(c.title ?? ""),
    }));
});
</script>

<template src="./SearchIntentHint.html"></template>

<style scoped src="./SearchIntentHint.scoped.css"></style>

