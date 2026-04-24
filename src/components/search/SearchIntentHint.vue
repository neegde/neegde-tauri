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
  /** User asked to search the literal string instead of the resolver's canonical pair. */
  "revert-to-raw",
]);

const hasCanonical = computed(() => Boolean(props.resolved?.canonical?.artist));

/**
 * Strip bracketed annotations before quoting — matches `stripBrackets` in
 * `src/search/engine.ts` so the hint shows exactly what was sent to the
 * providers, not the raw canonical (which often carries Latin-in-parens
 * translations like "Леонид Агутин (Leonid Agutin)").
 */
function stripBrackets(s) {
  return String(s ?? "")
    .replace(/\([^()]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** What the engine effectively searched for — matches the providerQ formula in engine.ts. */
const canonicalText = computed(() => {
  const a = stripBrackets(props.resolved?.canonical?.artist ?? "");
  const t = stripBrackets(props.resolved?.canonical?.title ?? "");
  if (a && t) return `${a} ${t}`;
  return a;
});
</script>

<template src="./SearchIntentHint.html"></template>

<style scoped src="./SearchIntentHint.scoped.css"></style>

