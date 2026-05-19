import { peekSlskCover, getSlskCoverDataUrl } from "./coverCache.js";
import { appDebugLog } from "../appDebugLog.js";

/** Full basename list for manual / exhaustive folder cover probing. */
export const SLSK_FOLDER_COVER_NAMES_EXHAUSTIVE = [
  "folder.jpg",
  "cover.jpg",
  "front.jpg",
  "album.jpg",
  "cover.png",
  "folder.png",
];

/** Fast path for lazy search rows — two common names only. */
export const SLSK_FOLDER_COVER_NAMES_AUTO = ["folder.jpg", "cover.jpg"];

const inFlightAuto = new Map<string, Promise<string | null>>();
const inFlightExhaustive = new Map<string, Promise<string | null>>();

function guessKey(username: string, dir: string): string {
  const normDir = dir.replace(/\\/g, "/");
  return `${username}\n${normDir}`;
}

/**
 * Probes peer folder images until one resolves to a data URL.
 *
 * Concurrent calls for the same `(username, dir, mode)` share one P2P
 * sequence so many tracks in one album folder do not multiply previews.
 *
 * @param username - SoulSeek peer username.
 * @param dir - Virtual folder prefix ending with a path separator.
 * @param signal - Optional abort; honoured between candidates.
 * @param exhaustive - When false, only {@link SLSK_FOLDER_COVER_NAMES_AUTO} is tried.
 * @returns First filepath that returned cover bytes, or null.
 */
export function guessSlskFolderCoverPath(
  username: string,
  dir: string,
  signal: AbortSignal | undefined,
  exhaustive: boolean,
): Promise<string | null> {
  const key = guessKey(username, dir);
  const map = exhaustive ? inFlightExhaustive : inFlightAuto;
  const existing = map.get(key);
  if (existing) return existing;

  const names = exhaustive ? SLSK_FOLDER_COVER_NAMES_EXHAUSTIVE : SLSK_FOLDER_COVER_NAMES_AUTO;
  const work = (async (): Promise<string | null> => {
    void appDebugLog(
      "cover",
      `slsk folder guess — user=${username} dir=${dir.slice(-60)} exhaustive=${exhaustive}`,
    );
    for (const name of names) {
      if (signal?.aborted) return null;
      const guessPath = dir + name;
      if (peekSlskCover(username, guessPath) === null) continue;
      const result = await getSlskCoverDataUrl(username, guessPath, 0).catch(() => null);
      if (signal?.aborted) return null;
      if (result) {
        void appDebugLog("cover", `slsk folder guess hit — user=${username} file=${name}`);
        return guessPath;
      }
    }
    void appDebugLog(
      "cover",
      `slsk folder guess miss — user=${username} dir=${dir.slice(-60)} exhaustive=${exhaustive}`,
    );
    return null;
  })().finally(() => {
    map.delete(key);
  });
  map.set(key, work);
  return work;
}
