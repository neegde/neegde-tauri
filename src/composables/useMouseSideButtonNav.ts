/**
 * Mouse side-button navigation.
 *
 * Binds the mouse X1/X2 (back/forward) buttons to app-level navigation.
 * Wry on macOS only delivers these as MouseEvent with button codes 3/4/8/9;
 * on `mouseup` without preventDefault, it would also trigger the built-in
 * `history.back()` / `history.forward()`, so the `mouseup` handler cancels
 * those too.
 */

import { onMounted, onUnmounted, type Ref, type ComputedRef } from "vue";

const LISTEN_OPTS: AddEventListenerOptions = { capture: true, passive: false };

function isBackButton(e: MouseEvent): boolean {
  const b = e.button;
  if (b === 3 || b === 8) return true;
  return (e.buttons & 8) === 8;
}

function isForwardButton(e: MouseEvent): boolean {
  const b = e.button;
  if (b === 4 || b === 9) return true;
  return (e.buttons & 16) === 16;
}

function isAnySideButton(e: MouseEvent): boolean {
  const b = e.button;
  return b === 3 || b === 4 || b === 8 || b === 9;
}

export interface UseMouseSideButtonNavCfg {
  canGoBack: Ref<boolean> | ComputedRef<boolean>;
  canGoForward: Ref<boolean> | ComputedRef<boolean>;
  onBack: () => void;
  onForward: () => void;
}

export function useMouseSideButtonNav(cfg: UseMouseSideButtonNavCfg): void {
  function onDown(e: MouseEvent): void {
    if (!isBackButton(e) && !isForwardButton(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (isBackButton(e) && cfg.canGoBack.value) {
      cfg.onBack();
    } else if (isForwardButton(e) && cfg.canGoForward.value) {
      cfg.onForward();
    }
  }

  function onUp(e: MouseEvent): void {
    if (!isAnySideButton(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  onMounted(() => {
    window.addEventListener("mousedown", onDown, LISTEN_OPTS);
    window.addEventListener("mouseup", onUp, LISTEN_OPTS);
  });

  onUnmounted(() => {
    window.removeEventListener("mousedown", onDown, LISTEN_OPTS);
    window.removeEventListener("mouseup", onUp, LISTEN_OPTS);
  });
}
