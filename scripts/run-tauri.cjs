const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/**
 * Prepends `dir` to PATH in `env` when the directory exists on disk.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dir
 */
function prependPathIfDirExists(env, dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const cur = env.PATH || env.Path || "";
  const sep = path.delimiter;
  const next = `${dir}${sep}${cur}`;
  env.PATH = next;
  if (process.platform === "win32") env.Path = next;
}

/**
 * When vcpkg is installed under `%USERPROFILE%/vcpkg` (or `VCPKG_ROOT`), expose
 * toolchain and prefix so CMake in `build.rs` finds Boost/OpenSSL on Windows.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function applyWindowsVcpkgEnv(env) {
  if (process.platform !== "win32") return;
  const home = env.USERPROFILE || "";
  const root = env.VCPKG_ROOT || path.join(home, "vcpkg");
  const toolchain = path.join(root, "scripts", "buildsystems", "vcpkg.cmake");
  const installed = path.join(root, "installed", "x64-windows");
  if (!fs.existsSync(toolchain)) return;
  if (!env.VCPKG_ROOT) env.VCPKG_ROOT = root;
  if (!env.CMAKE_TOOLCHAIN_FILE) env.CMAKE_TOOLCHAIN_FILE = toolchain;
  const pre = env.CMAKE_PREFIX_PATH || "";
  const sep = path.delimiter;
  env.CMAKE_PREFIX_PATH = pre ? `${pre}${sep}${installed}` : installed;
  if (!env.BOOST_ROOT) env.BOOST_ROOT = installed;
  if (!env.OPENSSL_ROOT_DIR) env.OPENSSL_ROOT_DIR = installed;
}

/**
 * Adds common CMake `bin` locations on Windows if present (winget default).
 *
 * @param {NodeJS.ProcessEnv} env
 */
function prependWindowsCmakeBin(env) {
  if (process.platform !== "win32") return;
  const pf = env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  prependPathIfDirExists(env, path.join(pf, "CMake", "bin"));
  prependPathIfDirExists(env, path.join(pf86, "CMake", "bin"));
}

const args = process.argv.slice(2);
const env = { ...process.env };
const userProfile = env.USERPROFILE || "";

prependPathIfDirExists(env, path.join(userProfile, ".cargo", "bin"));
prependWindowsCmakeBin(env);
applyWindowsVcpkgEnv(env);

const isWindows = process.platform === "win32";
const tauriCommand = isWindows ? "cmd.exe" : "tauri";
const tauriArgs = isWindows ? ["/d", "/s", "/c", "tauri.cmd", ...args] : args;

const child = spawn(tauriCommand, tauriArgs, {
  env,
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
