/**
 * In-memory blacklist of SLSK peers that proved broken in *this* app session.
 *
 * SoulSeek's server-reported stats (`slotsFree`, `queueLength`, `avgSpeed`)
 * only describe the peer as the server sees them. In practice a peer can
 * reply to searches with "slots=Y queue=0" while its actual upload channel
 * is dead (NAT, firewall, stale share index, version mismatch). We learn
 * this only by attempting a transfer and watching it fail.
 *
 * Once a peer has demonstrably failed, we stop wasting parallel races on
 * them AND hide search results whose every seeder is already blacklisted.
 * The blacklist is a reactive ref so Vue computeds can depend on it and
 * auto-re-render when a peer is marked dead mid-session. Entries self-
 * expire after {@link BLACKLIST_TTL_MS} so a peer that came back online
 * (restart, NAT re-punch) gets a second chance later.
 */

import { ref } from "vue";

const BLACKLIST_TTL_MS = 10 * 60 * 1000; // 10 minutes

const dead = new Map<string, number>(); // username → expiresAt (ms epoch)
/** Bumped on every mutation so reactive consumers re-evaluate. */
export const peerBlacklistVersion = ref<number>(0);

/** Called on any prepare/transfer failure for this peer. */
export function markPeerDead(username: string): void {
  if (!username) return;
  dead.set(username, Date.now() + BLACKLIST_TTL_MS);
  peerBlacklistVersion.value += 1;
}

/** True when we're actively avoiding this peer. */
export function isPeerDead(username: string): boolean {
  if (!username) return false;
  const expires = dead.get(username);
  if (!expires) return false;
  if (expires <= Date.now()) {
    dead.delete(username);
    peerBlacklistVersion.value += 1;
    return false;
  }
  return true;
}

/** For debugging / settings reset. */
export function clearPeerBlacklist(): void {
  dead.clear();
  peerBlacklistVersion.value += 1;
}
