import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

/**
 * Vitest config.
 *
 * Environment: jsdom (needed for Vue SFC + DOM APIs like IntersectionObserver).
 * Coverage: v8 with strict thresholds. Anything the team doesn't test must be
 * explicitly excluded (dev-only windows, Tauri FFI passthrough wrappers, etc.)
 * via the `exclude` list or inline `/* v8 ignore next *\/` comments.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "src-tauri"],
    setupFiles: ["tests/_setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: [
        "src/**/*.{ts,js,vue}",
      ],
      exclude: [
        // Entry points / boot scaffolding — tested via integration, not unit.
        "src/main.js",
        "src/appDebugWindow.js",
        // Dev-only UI surfaces (debug window, splash) — visual, low value.
        "src/components/debug/**",
        "src/components/shell/AppSplash.vue",
        // Unused dead branch kept for reference.
        "src/components/unused/**",
        // HTML template partials — compiled into .vue SFCs, already covered.
        "src/**/*.html",
        // CSS, assets.
        "src/**/*.css",
        "src/assets/**",
        // Style module entry.
        "src/style.css",
      ],
      thresholds: {
        lines: 98,
        statements: 98,
        functions: 98,
        branches: 95,
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
