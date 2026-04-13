const LS_KEY = "neegde.playlists.v1";

function generateId() {
  return `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadPlaylists() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(playlists) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(playlists));
  } catch {}
}

export function createPlaylist(name) {
  const playlists = loadPlaylists();
  const pl = {
    id: generateId(),
    name: name.trim() || "Плейлист",
    createdAt: Date.now(),
    tracks: [],
  };
  playlists.push(pl);
  save(playlists);
  return playlists;
}

export function deletePlaylist(id) {
  const playlists = loadPlaylists().filter((p) => p.id !== id);
  save(playlists);
  return playlists;
}

export function renamePlaylist(id, name) {
  const n = name.trim();
  if (!n) return loadPlaylists();
  const playlists = loadPlaylists().map((p) =>
    p.id === id ? { ...p, name: n } : p
  );
  save(playlists);
  return playlists;
}

/**
 * @param {string} playlistId
 * @param {{ magnet, fileIdx, fileName, torrentName, torrentId, source, artist?, coverFileIdx? }} track
 */
export function addTrackToPlaylist(playlistId, track) {
  const playlists = loadPlaylists();
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) return playlists;
  const exists = pl.tracks.some(
    (t) => t.magnet === track.magnet && t.fileIdx === track.fileIdx
  );
  if (!exists) {
    pl.tracks.push({ ...track, addedAt: Date.now() });
  }
  save(playlists);
  return playlists;
}

export function removeTrackFromPlaylist(playlistId, magnet, fileIdx) {
  const playlists = loadPlaylists();
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) return playlists;
  pl.tracks = pl.tracks.filter(
    (t) => !(t.magnet === magnet && t.fileIdx === fileIdx)
  );
  save(playlists);
  return playlists;
}
