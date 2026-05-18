<script setup>
import { computed } from "vue";
import SystemIcon from "../shared/SystemIcon.vue";

const props = defineProps({
  state:   { type: Object, default: null },
  running: { type: Boolean, default: false },
});

const emit = defineEmits(["cancel", "close"]);

const progressPct = computed(() => {
  const s = props.state;
  if (!s || s.total === 0) return 0;
  return Math.round((s.done / s.total) * 100);
});

const canClose = computed(() => !props.running);

function handleClose() {
  if (!canClose.value) return;
  emit("close");
}
</script>

<template src="./ImportProgressModal.html"></template>
<style scoped src="./ImportProgressModal.scoped.css"></style>
