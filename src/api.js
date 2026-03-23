/**
 * URL для воспроизведения или превью файла из торрента (обложка в папке, трек и т.д.).
 * В десктоп-сборке пока пусто — когда появится нативный стриминг, вернуть рабочий URL.
 * @param {string} magnet
 * @param {number} fileIdx
 */
export function streamUrl(magnet, fileIdx) {
  if (!magnet || fileIdx == null || fileIdx < 0) return "";
  return "";
}
