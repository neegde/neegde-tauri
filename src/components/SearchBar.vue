<script setup>
import { ref } from "vue";

const props = defineProps({
  loading: Boolean,
  showCategories: { type: Boolean, default: true },
});

const emit = defineEmits(["search"]);

const CATS = [
  { id: "100", label: "Все" },
  { id: "101", label: "MP3" },
  { id: "104", label: "FLAC" },
];

const query = ref("");
const cat = ref("100");

function submit(e) {
  e.preventDefault();
  if (query.value.trim()) emit("search", query.value.trim(), cat.value);
}
</script>

<template>
  <form class="search-form" @submit="submit">
    <div class="search-input-wrap">
      <span class="search-icon">♫</span>
      <input
        class="search-input"
        type="text"
        placeholder="Название группы или исполнителя…"
        v-model="query"
        autofocus
      />
      <button class="search-btn" type="submit" :disabled="loading || !query.trim()">
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
</template>
