import { ref, shallowRef } from "vue";
import { loadGeneralList, type GeneralListEntry } from "../persistence/generalList.js";

const _open = ref(false);
const _entry = shallowRef<GeneralListEntry | null>(null);

export function showTrackInfo(trackId: string): void {
  _entry.value = loadGeneralList().entries[trackId] ?? null;
  _open.value = true;
}

export function useTrackInfo() {
  return {
    open: _open,
    entry: _entry,
    close(): void { _open.value = false; },
  };
}
