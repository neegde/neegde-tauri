/** Локально помним, что пользователь хотя бы раз успешно входил в Rutracker. */

const KEY = "neegde.rutracker.hadAccount";

export function markRutrackerHadAccount(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearRutrackerHadAccount(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function hadRutrackerAccount(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
