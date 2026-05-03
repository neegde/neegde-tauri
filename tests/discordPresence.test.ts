import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockInvoke } from "./_setup.js";

import { syncDiscordPresence, clearDiscordPresence } from "../src/discordPresence.js";

beforeEach(() => {
  mockInvoke.mockReset();
  vi.useFakeTimers();
  // Make "isTauriRuntime" succeed by setting the sentinel.
  (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("discordPresence", () => {
  it("no-op outside Tauri runtime", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await syncDiscordPresence({ title: "a", subtitle: "b", playing: true, positionSec: 0, durationSec: 0 });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("sync with immediate=true invokes right away", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await syncDiscordPresence({
      title: "A", subtitle: "B", playing: true, positionSec: 10, durationSec: 200,
    }, { immediate: true });
    expect(mockInvoke).toHaveBeenCalledWith("discord_presence_sync", expect.any(Object));
  });

  it("sync without immediate debounces", () => {
    mockInvoke.mockResolvedValue(undefined);
    void syncDiscordPresence({ title: "a", subtitle: "b", playing: true, positionSec: 0, durationSec: 0 });
    expect(mockInvoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4500);
    expect(mockInvoke).toHaveBeenCalled();
  });

  it("second debounced call resets timer", () => {
    mockInvoke.mockResolvedValue(undefined);
    void syncDiscordPresence({ title: "a", subtitle: "b", playing: true, positionSec: 0, durationSec: 0 });
    vi.advanceTimersByTime(2000);
    void syncDiscordPresence({ title: "a", subtitle: "b", playing: true, positionSec: 0, durationSec: 0 });
    vi.advanceTimersByTime(3000);
    expect(mockInvoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("clearDiscordPresence cancels pending + invokes clear", async () => {
    mockInvoke.mockResolvedValue(undefined);
    void syncDiscordPresence({ title: "a", subtitle: "b", playing: true, positionSec: 0, durationSec: 0 });
    await clearDiscordPresence();
    vi.advanceTimersByTime(10_000);
    // Only clear call — pending debounce was cancelled.
    expect(mockInvoke).toHaveBeenCalledWith("discord_presence_clear");
  });

  it("clear outside Tauri is no-op", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await clearDiscordPresence();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
