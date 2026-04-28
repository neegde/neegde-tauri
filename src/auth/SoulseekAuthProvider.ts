import { ref, type Ref } from "vue";
import { AuthProvider } from "./AuthProvider.js";

/**
 * SoulSeek auth — adds the login-in-flight flag and the last-error slot.
 *
 * `connect()` clears the error (login succeeded); `disconnect()` leaves the
 * error alone, so a UI that rendered "connection dropped: …" sticks until
 * the user explicitly clears it or a new successful connect overwrites it.
 */
export class SoulseekAuthProvider extends AuthProvider {
  readonly kind = "soulseek" as const;
  readonly loggingIn: Ref<boolean> = ref(false);
  readonly loginError: Ref<string | null> = ref(null);

  override connect(username?: string | null): void {
    super.connect(username);
    this.loginError.value = null;
  }
}
