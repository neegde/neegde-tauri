/**
 * Strips a leading "v" from a version tag.
 *
 * @param {string} tag - Version or tag string.
 * @returns {string}
 */
export function normalizeVersionTag(tag) {
  const t = String(tag).trim();
  if (t.length > 0 && (t[0] === "v" || t[0] === "V")) return t.slice(1);
  return t;
}

/**
 * Compares two semver-like dotted version strings (numeric segments).
 *
 * @param {string} a - First version.
 * @param {string} b - Second version.
 * @returns {number} Negative if a < b, positive if a > b, zero if equal.
 */
export function compareSemver(a, b) {
  const ca = normalizeVersionTag(a).split("-")[0].split("+")[0];
  const cb = normalizeVersionTag(b).split("-")[0].split("+")[0];
  const pa = ca.split(".").map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pb = cb.split(".").map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/**
 * Fetches the latest published release from the GitHub REST API.
 *
 * @param {string} apiUrl - e.g. https://api.github.com/repos/o/r/releases/latest
 * @returns {Promise<{ tagName: string, htmlUrl: string } | null>}
 */
export function fetchLatestGithubRelease(apiUrl) {
  if (!apiUrl) return Promise.resolve(null);
  return fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
    .then((res) => {
      if (res.status === 404) return null;
      if (!res.ok) {
        return Promise.reject(new Error(`GitHub API: ${res.status}`));
      }
      return res.json();
    })
    .then((data) => {
      if (!data || typeof data.tag_name !== "string") return null;
      const htmlUrl =
        typeof data.html_url === "string" ? data.html_url : "";
      return { tagName: data.tag_name, htmlUrl };
    });
}
