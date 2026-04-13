import { readFileSync, existsSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8")
);

/**
 * Builds GitHub REST URL for the latest release from npm `repository.url`.
 *
 * @param {typeof pkg} packageJson
 * @returns {string} Empty string if the repo is not on GitHub.
 */
function githubLatestReleaseApiUrl(packageJson) {
  const raw = packageJson.repository?.url;
  if (!raw || typeof raw !== "string") return "";
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!m) return "";
  return `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`;
}

/**
 * Public GitHub repo URL from npm `repository.url`.
 *
 * @param {typeof pkg} packageJson
 * @returns {string} Empty string if the repo is not on GitHub.
 */
function githubRepoWebUrl(packageJson) {
  const raw = packageJson.repository?.url;
  if (!raw || typeof raw !== "string") return "";
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
  if (!m) return "";
  return `https://github.com/${m[1]}/${m[2]}`;
}

/**
 * Reads vozduxan version from the submodule's CMakeLists.txt.
 * Returns empty string if the submodule is not initialized.
 */
function vozduxanVersion() {
  const cmakePath = new URL("./vozduxan/CMakeLists.txt", import.meta.url);
  if (!existsSync(cmakePath)) return "";
  const content = readFileSync(cmakePath, "utf-8");
  const m = content.match(/project\s*\(\s*vozduxan\s+VERSION\s+([\d.]+)/);
  return m ? m[1] : "";
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __VOZDUXAN_VERSION__: JSON.stringify(vozduxanVersion()),
    __GITHUB_RELEASES_LATEST_API__: JSON.stringify(
      githubLatestReleaseApiUrl(pkg)
    ),
    __GITHUB_PROJECT_URL__: JSON.stringify(githubRepoWebUrl(pkg)),
    __TELEGRAM_CHANNEL_URL__: JSON.stringify(
      typeof pkg.neegde?.telegramChannel === "string"
        ? pkg.neegde.telegramChannel
        : ""
    ),
  },
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5183 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
