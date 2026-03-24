/** Локально помним, что пользователь хотя бы раз успешно входил в Rutracker (для UI при сбоях). */

const KEY = "neegde.rutracker.hadAccount";

export function markRutrackerHadAccount() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearRutrackerHadAccount() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function hadRutrackerAccount() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
