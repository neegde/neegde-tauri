import { invoke } from "@tauri-apps/api/core";

/** Appends one line to the application debug log (when debug mode is on). */
export async function appDebugLog(
  category: string,
  message: string,
  detail?: unknown,
): Promise<void> {
  await invoke("app_debug_push", {
    category,
    message,
    detail: detail ?? null,
  }).catch(() => {});
}

export interface ClickDetail {
  tag?: string;
  path?: string;
  textPreview?: string;
}

/** Builds a compact DOM path + text preview for click logging (no passwords). */
export function appDebugClickDetail(el: unknown): ClickDetail {
  if (!el || typeof el !== "object") return { tag: "unknown" };
  if (el === document.body) return { tag: "body" };
  const parts: string[] = [];
  let n: Element | null = el as Element;
  for (let i = 0; i < 8 && n && n !== document.documentElement; i++) {
    let bit = n.tagName?.toLowerCase() ?? "?";
    if (n.id) bit += `#${n.id}`;
    else if (typeof (n as unknown as { className: string }).className === "string") {
      const cls = (n as unknown as { className: string }).className;
      const c = cls
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
  const target = el as Element & { innerText?: string };
  const interactive = target.closest?.(
    "button, a, [role='button'], input, select, textarea, label, [data-app-debug]",
  ) as (Element & { innerText?: string }) | null;
  const textPreview =
    interactive?.innerText?.trim?.()?.slice(0, 100) ||
    target.innerText?.trim?.()?.slice(0, 80) ||
    "";
  return {
    path: parts.join(" > "),
    textPreview: textPreview || undefined,
  };
}
