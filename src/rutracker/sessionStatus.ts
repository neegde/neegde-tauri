export interface NormalizedLoginStatus {
  loggedIn: boolean;
  username: string | null;
  avatarUrl: string | null;
}

/**
 * Tauri/serde may expose either snake_case or camelCase on the JS side.
 */
export function normalizeLoginStatus(raw: unknown): NormalizedLoginStatus {
  if (!raw || typeof raw !== "object") {
    return { loggedIn: false, username: null, avatarUrl: null };
  }
  const r = raw as Record<string, unknown>;
  const loggedIn = Boolean(r.logged_in ?? r.loggedIn);
  const username = r.username != null ? String(r.username) : null;
  const avatarUrl =
    (r.avatar_url ?? r.avatarUrl) != null
      ? String(r.avatar_url ?? r.avatarUrl)
      : null;
  return { loggedIn, username, avatarUrl };
}
