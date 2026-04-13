<script setup>
import { ref } from "vue";

const props = defineProps({
  modelValue: { type: String, default: "" },
  loading: Boolean,
  showCategories: { type: Boolean, default: true },
});

const emit = defineEmits(["search", "update:modelValue"]);

const CATS = [
  { id: "100", label: "Все" },
  { id: "101", label: "MP3" },
  { id: "104", label: "FLAC" },
];

const cat = ref("100");

function submit(e) {
  e.preventDefault();
  emit("search", props.modelValue.trim(), cat.value);
}

function clear() {
  emit("update:modelValue", "");
  emit("search", "", cat.value);
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
        :value="modelValue"
        @input="emit('update:modelValue', $event.target.value)"
      />
      <button
        v-if="modelValue"
        type="button"
        class="search-clear-btn"
        title="Очистить"
        @click="clear"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <button class="search-btn" type="submit" :disabled="loading">
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
