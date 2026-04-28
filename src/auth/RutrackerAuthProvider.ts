import { ref, type Ref } from "vue";
import { AuthProvider } from "./AuthProvider.js";

/**
 * RuTracker auth — adds the user's avatar URL alongside the common
 * connected / username state.
 */
export class RutrackerAuthProvider extends AuthProvider {
  readonly kind = "rutracker" as const;
  readonly avatarUrl: Ref<string | null> = ref(null);

  override connect(username?: string | null, avatarUrl?: string | null): void {
    super.connect(username);
    this.avatarUrl.value = avatarUrl || null;
  }

  override disconnect(): void {
    super.disconnect();
    this.avatarUrl.value = null;
  }
}
