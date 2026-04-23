<script setup lang="ts">
import { ref, toRef, type Ref } from "vue";
import type { Track } from "../../track/Track.js";
import type { AlbumData } from "../../stores/entities.js";
import { useEntityCover } from "../../composables/useEntityCover.js";

const props = defineProps<{
  entity: Track | AlbumData | null;
  size?: number;
  fill?: boolean;
}>();

const rootRef = ref<HTMLElement | null>(null);
const { coverUrl, coverErr } = useEntityCover(
  toRef(props, "entity") as Ref<Track | AlbumData | null>,
  rootRef,
);
</script>

<template>
  <div
    ref="rootRef"
    :class="['track-cover', fill ? 'track-cover--fill' : '']"
    :style="fill ? undefined : { width: (size ?? 44) + 'px', height: (size ?? 44) + 'px' }"
  >
    <img
      v-if="coverUrl && !coverErr"
      :src="coverUrl"
      :class="fill ? 'album-art-img' : 'track-cover-img'"
      alt=""
      draggable="false"
      @error="coverErr = true"
    />
    <svg v-else class="track-cover-fallback" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  </div>
</template>

<style scoped>
.track-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-2, #2a2a2a);
  flex-shrink: 0;
}
.track-cover--fill { width: 100%; height: 100%; }
.track-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.track-cover-fallback {
  width: 60%;
  height: 60%;
  opacity: 0.4;
}
</style>
