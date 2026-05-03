/**
 * Abstract base for authentication providers.
 *
 * Holds the *observed state* of a provider — whether we're currently logged
 * in / connected, and under which username. Subsystem modules (RuTracker,
 * SoulSeek) do the actual network calls and then call `connect(...)` /
 * `disconnect()` on the matching provider instance.
 *
 * Subclasses can add provider-specific reactive fields (avatar URL,
 * transient login-in-flight flags, error surfaces) and override
 * `connect` / `disconnect` to keep them in sync.
 */

import { ref, type Ref } from "vue";

export abstract class AuthProvider {
  abstract readonly kind: string;

  readonly connected: Ref<boolean> = ref(false);
  readonly username: Ref<string | null> = ref(null);

  connect(username?: string | null): void {
    this.connected.value = true;
    this.username.value = username || null;
  }

  disconnect(): void {
    this.connected.value = false;
    this.username.value = null;
  }
}
