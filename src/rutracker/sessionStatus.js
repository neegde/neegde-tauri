/**
 * Tauri/serde may expose either snake_case or camelCase on the JS side.
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {{ loggedIn: boolean, username: string | null, avatarUrl: string | null }}
 */
export function normalizeLoginStatus(raw) {
  if (!raw || typeof raw !== "object") {
    return { loggedIn: false, username: null, avatarUrl: null };
  }
  const loggedIn = Boolean(raw.logged_in ?? raw.loggedIn);
  const username =
    raw.username != null ? String(raw.username) : null;
  const avatarUrl =
    (raw.avatar_url ?? raw.avatarUrl) != null
      ? String(raw.avatar_url ?? raw.avatarUrl)
      : null;
  return { loggedIn, username, avatarUrl };
}
