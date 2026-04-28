<script setup>
import { toRefs } from "vue";

const props = defineProps({
  /** Validation or resolver error message. */
  error: { type: String, default: null },
  /** Waiting for librqbit metadata (DHT / trackers). */
  resolving: { type: Boolean, default: false },
});

const { error, resolving } = toRefs(props);

const open = defineModel("open", { type: Boolean, default: false });
const draft = defineModel("draft", { type: String, default: "" });

const emit = defineEmits(["submit", "close"]);

function onOverlayClick() {
  emit("close");
}

function onSubmit() {
  emit("submit");
}

function onKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if (!resolving.value) emit("submit");
  }
}
</script>

<template src="./MagnetLinkDialog.html"></template>

<style scoped src="./MagnetLinkDialog.scoped.css"></style>

