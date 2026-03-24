/**
 * Reserved for cleaning up torrent streaming / preview state when leaving a release
 * or switching magnet.
 */
import { invoke } from "@tauri-apps/api/core";

export function disposeTorrentPreview() {
  return invoke("torrent_dispose_preview").catch(() => {});
}
