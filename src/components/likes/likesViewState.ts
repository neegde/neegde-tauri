import { ref } from "vue";

export type LikesTab = "tracks" | "albums";

/**
 * Active sub-tab on the «Мне нравится» screen.
 *
 * Lives at module scope so it survives the LikesView remount that happens
 * when the user navigates away. The surrounding `<KeepAlive>` in App.html
 * is itself nested inside the `v-else-if` wrapper, so it can't actually
 * cache anything — when `view !== "likes"` the entire wrapper (KeepAlive
 * included) is unmounted. Same pattern as `slskMetaStore.ts` for SoulSeek
 * search metadata.
 */
export const likesTab = ref<LikesTab>("tracks");
