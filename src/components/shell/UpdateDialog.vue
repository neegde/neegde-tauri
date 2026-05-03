<script setup lang="ts">
defineProps<{
  visible: boolean;
  version: string;
  date: string;
  notesHtml: string;
  installing: boolean;
  installProgress: number;
  installError: string;
}>();

const emit = defineEmits<{
  (e: "install"): void;
  (e: "close"): void;
}>();
</script>

<template src="./UpdateDialog.html"></template>
<style scoped src="./UpdateDialog.scoped.css"></style>
