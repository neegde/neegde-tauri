<script setup>
import AlbumCard from "./AlbumCard.vue";

const props = defineProps({
  results: Array,
  selectedId: { default: null },
});

const emit = defineEmits(["select"]);
</script>

<template>
  <div v-if="results.length">
    <div class="section-header">
      <h2 class="section-title">Результаты</h2>
      <span class="section-count">{{ results.length }} раздач</span>
    </div>
    <div class="results-grid">
      <AlbumCard
        v-for="(r, i) in results"
        :key="r.id ?? i"
        :torrent="r"
        :selected="selectedId === r.id"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>
