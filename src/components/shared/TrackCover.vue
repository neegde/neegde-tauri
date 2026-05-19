<script setup lang="ts">
import { ref, toRef, computed, type Ref } from "vue";
import type { Track } from "../../track/Track.js";
import type { Album } from "../../album/Album.js";
import { useEntityCover } from "../../composables/useEntityCover.js";
import CoverLightbox from "./CoverLightbox.vue";

const props = defineProps<{
  entity: Track | Album | null;
  /** Takes priority over the entity's own cover (e.g. MusicBrainz enrichment). */
  overrideUrl?: string;
  size?: number;
  fill?: boolean;
  /** Click on the cover opens a fullscreen lightbox. Off by default. */
  enlargeable?: boolean;
  alt?: string;
}>();

const rootRef = ref<HTMLElement | null>(null);
const { coverUrl: entityCoverUrl, coverErr, fetching } = useEntityCover(
  toRef(props, "entity") as Ref<Track | Album | null>,
  rootRef,
);

const coverUrl = computed<string | null>(() => {
  const ov = props.overrideUrl?.trim();
  if (ov) return ov;
  return entityCoverUrl.value;
});

const canEnlarge = computed<boolean>(
  () => !!props.enlargeable && !!coverUrl.value && !coverErr.value,
);

const lightboxOpen = ref(false);

/**
 * Open the lightbox when the cover is enlargeable and an image is loaded.
 *
 * @param e - Click event; bubbling is suppressed so parent rows don't navigate.
 */
function onCoverClick(e: MouseEvent): void {
  if (!canEnlarge.value) return;
  e.stopPropagation();
  lightboxOpen.value = true;
}
</script>

<template>
  <div
    ref="rootRef"
    :class="[
      'track-cover',
      fill ? 'track-cover--fill' : '',
      canEnlarge ? 'track-cover--enlargeable' : '',
    ]"
    :style="fill ? undefined : { width: (size ?? 44) + 'px', height: (size ?? 44) + 'px' }"
    @click="onCoverClick"
  >
    <img
      v-if="coverUrl && !coverErr"
      :src="coverUrl"
      class="track-cover-img"
      alt=""
      draggable="false"
      @error="coverErr = true"
    />
    <div v-else-if="fetching" class="cover-loading-spinner" />
    <svg v-else class="track-cover-fallback" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
    <CoverLightbox
      v-model:open="lightboxOpen"
      :src="coverUrl || ''"
      :alt="alt || ''"
      large
    />
  </div>
</template>

<style scoped>
.track-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  overflow: hidden;
  background: var(--surface-h, #2a2a2a);
  flex-shrink: 0;
}
.track-cover--fill { width: 100%; height: 100%; position: relative; }
.track-cover--fill .track-cover-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
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
.track-cover--enlargeable {
  cursor: zoom-in;
}
.track-cover--enlargeable .track-cover-img {
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.track-cover--enlargeable:hover .track-cover-img {
  transform: scale(1.02);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
}
</style>
