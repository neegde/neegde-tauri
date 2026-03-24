/**
 * Индекс файла обложки в торренте для лайкнутого трека — как в списке лайков:
 * вложенный coverFile, затем coverFileIdx, затем лайкнутый альбом той же раздачи.
 * @param {object} like
 * @param {object[]|Record<string, object>} allLikes — массив лайков или map id → like
 */
export function trackCoverFileIdxForLike(like, allLikes) {
  if (like.coverFile?.origIdx != null) return like.coverFile.origIdx;
  if (like.coverFileIdx != null) return like.coverFileIdx;
  const list = Array.isArray(allLikes) ? allLikes : Object.values(allLikes ?? {});
  const album = list.find(
    (l) =>
      l.type === "album" &&
      String(l.torrentId) === String(like.torrentId) &&
      l.audioFiles?.some((f) => f.origIdx === like.fileIdx)
  );
  return album?.coverFile?.origIdx ?? null;
}
