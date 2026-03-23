<script setup>
import { ref } from "vue";

const props = defineProps({
  src: String,
  imgClass: String,
});

const emit = defineEmits(["error"]);

const loaded = ref(false);
</script>

<template>
  <div v-if="!loaded" class="cover-shimmer" />
  <img
    :src="src"
    :class="[imgClass, 'cover-fade']"
    :style="{ opacity: loaded ? 1 : 0 }"
    alt=""
    @load="loaded = true"
    @error="emit('error')"
  />
</template>
