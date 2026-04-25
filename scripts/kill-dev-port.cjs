const { spawnSync } = require("node:child_process");

// Must match Vite / `tauri.conf.json` devUrl (default 5173).
const PORT = 5173;

const isWindows = process.platform === "win32";

if (isWindows) {
  const result = spawnSync("netstat", ["-ano"], {
    encoding: "utf8",
  });
  const pids = [
    ...new Set(
      (result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes(`:${PORT}`) && line.includes("LISTENING"))
        .map((line) => line.split(/\s+/).at(-1))
        .filter(Boolean),
    ),
  ];
  pids.forEach((pid) => {
    spawnSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
  });
} else {
  spawnSync("sh", ["-lc", `lsof -ti:${PORT} | xargs kill -9 2>/dev/null`], {
    stdio: "ignore",
  });
}
