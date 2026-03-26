import { invoke } from "@tauri-apps/api/core";

/**
 * Appends one line to the application debug log (when debug mode is on).
 *
 * Args:
 *     category: Short subsystem tag, e.g. `ui`, `player`, `prepare`.
 *     message: Human-readable line.
 *     detail: Optional JSON-serializable object.
 */
export async function appDebugLog(category, message, detail) {
  await invoke("app_debug_push", {
    category,
    message,
    detail: detail ?? null,
  }).catch(() => {});
}

/**
 * Builds a compact DOM path + text preview for click logging (no passwords).
 *
 * Args:
 *     el: Event target element.
 *
 * Returns:
 *     Object suitable as `detail` for `appDebugLog`.
 */
export function appDebugClickDetail(el) {
  if (!el || typeof el !== "object") return { tag: "unknown" };
  if (el === document.body) return { tag: "body" };
  const parts = [];
  let n = el;
  for (let i = 0; i < 8 && n && n !== document.documentElement; i++) {
    let bit = n.tagName?.toLowerCase() ?? "?";
    if (n.id) bit += `#${n.id}`;
    else if (n.className && typeof n.className === "string") {
      const c = n.className
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(".");
      if (c) bit += `.${c}`;
    }
    parts.unshift(bit);
    n = n.parentElement;
  }
  const interactive = el.closest?.(
    "button, a, [role='button'], input, select, textarea, label, [data-app-debug]",
  );
  const textPreview =
    interactive?.innerText?.trim?.()?.slice(0, 100) ||
    el.innerText?.trim?.()?.slice(0, 80) ||
    "";
  return {
    path: parts.join(" > "),
    textPreview: textPreview || undefined,
  };
}
