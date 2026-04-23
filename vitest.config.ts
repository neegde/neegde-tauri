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
  define: {
    __APP_VERSION__: JSON.stringify("test.0.0.0"),
    __VOZDUXAN_VERSION__: JSON.stringify("test"),
    __GITHUB_RELEASES_LATEST_API__: JSON.stringify(""),
    __GITHUB_PROJECT_URL__: JSON.stringify(""),
    __TELEGRAM_CHANNEL_URL__: JSON.stringify(""),
  },
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
        "src/main.ts",
        "src/appDebugWindow.ts",
        "src/AppDebugWindow.vue",
        "src/appDebugLog.ts",
        "src/playerVizWindow.ts",
        "src/PlayerVizStandalone.vue",
        // Dev-only UI surfaces (debug window, splash, onboarding) — visual, low value.
        "src/components/debug/**",
        "src/components/shell/AppSplash.vue",
        // Unused dead branch kept for reference.
        "src/components/unused/**",
        // Canvas / WebGL / audio graph: unrunnable in jsdom without extensive stubs.
        "src/audio/visualizerDrawFrame.ts",
        "src/audio/visualizerBroadcast.ts",
        "src/audio/equalizerGraph.ts",
        "src/audio/equalizerConfig.ts",
        "src/audio/equalizerState.ts",
        "src/components/player/PlayerVisualizerModal.vue",
        "src/components/player/visualizerPresets.ts",
        "src/composables/usePlayerEqualizer.ts",
        "src/composables/useStreamStats.ts",
        "src/composables/useStreamStatus.ts",
        "src/composables/useBufferPoll.ts",
        "src/composables/useBufferingWatchdog.ts",
        "src/composables/useDiscordPresence.ts",
        "src/composables/useMarquee.ts",
        // Static dev fixture.
        "src/dev/mockData.ts",
        // Torrent export paths — Tauri IPC passthrough, exercised integration-only.
        "src/torrent/torrentExport.ts",
        "src/torrent/torrentSession.ts",
        // HTML template partials — compiled into .vue SFCs, already covered.
        "src/**/*.html",
        // CSS, assets.
        "src/**/*.css",
        "src/assets/**",
        "src/style.css",
      ],
      // Progressive thresholds — raised as we add more tests. Target is
      // 98% lines / 95% branches; current floor is what the suite passes
      // today so CI doesn't block work while coverage ramps up.
      thresholds: {
        lines: 92,
        statements: 90,
        functions: 89,
        branches: 75,
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
