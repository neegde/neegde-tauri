/**
 * Сохранение очереди плеера (и позиции) между запусками приложения.
 */

const STORAGE_KEY = "neegde.playerSession.v1";

/**
 * @param {unknown} item
 * @returns {boolean}
 */
function isValidQueueItem(item) {
  if (!item || typeof item !== "object") return false;
  const m = item.magnet;
  if (typeof m !== "string" || !m.trim()) return false;
  const fi = item.fileIdx;
  if (fi == null || fi === "") return false;
  if (!Number.isFinite(Number(fi))) return false;
  return true;
}

/**
 * @returns {{ queue: object[], queuePos: number } | null}
 */
export function loadPlayerSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const queue = o.queue;
    if (!Array.isArray(queue) || queue.length === 0) return null;
    if (queue.length > 3000) return null;
    for (const item of queue) {
      if (!isValidQueueItem(item)) return null;
    }
    let pos = Number(o.queuePos);
    if (!Number.isFinite(pos)) pos = 0;
    pos = Math.floor(pos);
    pos = Math.min(Math.max(0, pos), queue.length - 1);
    return { queue, queuePos: pos };
  } catch {
    return null;
  }
}

/**
 * @param {object[]} queue
 * @param {number} queuePos
 */
export function savePlayerSession(queue, queuePos) {
  try {
    if (!Array.isArray(queue) || queue.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    let pos = Number(queuePos);
    if (!Number.isFinite(pos)) pos = 0;
    pos = Math.floor(Math.min(Math.max(0, pos), queue.length - 1));
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        queue,
        queuePos: pos,
        savedAt: Date.now(),
      })
    );
  } catch (e) {
    console.warn("[playerSession] save failed", e);
  }
}

export function clearPlayerSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
