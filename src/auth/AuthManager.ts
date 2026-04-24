/**
 * AuthManager — owner of the per-provider AuthProvider instances.
 *
 * One place to look up a provider by kind, and the natural home for any
 * future cross-provider concerns (e.g. "which provider is primary", global
 * "are we logged in anywhere", bootstrap flows).
 */

import type { AuthProvider } from "./AuthProvider.js";
import { RutrackerAuthProvider } from "./RutrackerAuthProvider.js";
import { SoulseekAuthProvider } from "./SoulseekAuthProvider.js";

export class AuthManager {
  readonly rutracker = new RutrackerAuthProvider();
  readonly soulseek = new SoulseekAuthProvider();

  get(kind: "rutracker"): RutrackerAuthProvider;
  get(kind: "soulseek"): SoulseekAuthProvider;
  get(kind: string): AuthProvider | undefined;
  get(kind: string): AuthProvider | undefined {
    if (kind === "rutracker") return this.rutracker;
    if (kind === "soulseek") return this.soulseek;
    return undefined;
  }
}
