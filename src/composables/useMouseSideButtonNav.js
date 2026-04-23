/**
 * Mouse side-button navigation.
 *
 * Binds the mouse X1/X2 (back/forward) buttons to app-level navigation.
 * Wry on macOS only delivers these as MouseEvent with button codes 3/4/8/9;
 * on `mouseup` without preventDefault, it would also trigger the built-in
 * `history.back()` / `history.forward()` (see wry `synthetic_mouse_events`),
 * so the `mouseup` handler cancels those too.
 *
 * Listeners are installed on mount and removed on unmount. The caller passes
 * reactive "can go" flags and handlers so the composable doesn't need to know
 * about the nav-stack shape.
 */

import { onMounted, onUnmounted } from "vue";

const LISTEN_OPTS = { capture: true, passive: false };

function isBackButton(e) {
  const b = e.button;
  if (b === 3 || b === 8) return true;
  return (e.buttons & 8) === 8;
}

function isForwardButton(e) {
  const b = e.button;
  if (b === 4 || b === 9) return true;
  return (e.buttons & 16) === 16;
}

/** On mouseup e.buttons is often 0 — check `button` only. */
function isAnySideButton(e) {
  const b = e.button;
  return b === 3 || b === 4 || b === 8 || b === 9;
}

/**
 * @param {{
 *   canGoBack: import("vue").Ref<boolean> | import("vue").ComputedRef<boolean>,
 *   canGoForward: import("vue").Ref<boolean> | import("vue").ComputedRef<boolean>,
 *   onBack: () => void,
 *   onForward: () => void,
 * }} cfg
 */
export function useMouseSideButtonNav(cfg) {
  function onDown(e) {
    if (!isBackButton(e) && !isForwardButton(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (isBackButton(e) && cfg.canGoBack.value) {
      cfg.onBack();
    } else if (isForwardButton(e) && cfg.canGoForward.value) {
      cfg.onForward();
    }
  }

  function onUp(e) {
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
