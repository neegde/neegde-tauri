import { invoke } from "@tauri-apps/api/core";

export interface SlskLoginResult { success: boolean; error: string | null; username: string | null }
export interface SlskStatus { connected: boolean; username: string | null }
export interface SlskStream { url: string; token: string }
export interface SlskCoverPreview { mime: string; base64: string }

/** Log in to SoulSeek network. */
export function soulseekLogin(username: string, password: string): Promise<SlskLoginResult> {
  return invoke<SlskLoginResult>("soulseek_login", { username, password });
}

/** Disconnect from SoulSeek network and release all streams. */
export function soulseekLogout(): Promise<void> {
  return invoke<void>("soulseek_logout");
}

export function soulseekStatus(): Promise<SlskStatus> {
  return invoke<SlskStatus>("soulseek_status");
}

/**
 * Blocks up to ~12s while collecting results; batches arrive earlier as
 * `soulseek-search-batch` events.
 */
export function soulseekSearch(query: string, requestId = 0): Promise<unknown[]> {
  return invoke<unknown[]>("soulseek_search", { query, requestId });
}

export function soulseekPrepareStream(
  username: string,
  filepath: string,
  filesize: number | string | null | undefined,
): Promise<SlskStream> {
  return invoke<SlskStream>("soulseek_prepare_stream", {
    username,
    filepath,
    filesize: Number(filesize) || 0,
  });
}

export function soulseekCoverPreview(
  username: string,
  filepath: string,
  filesize: number | string | null | undefined,
): Promise<SlskCoverPreview> {
  return invoke<SlskCoverPreview>("soulseek_cover_preview", {
    username,
    filepath,
    filesize: Number(filesize) || 0,
  });
}

export function soulseekReleaseStream(token: string): Promise<void> {
  return invoke<void>("soulseek_release_stream", { token });
}

export function soulseekSaveCredentials(username: string, password: string): Promise<void> {
  return invoke<void>("soulseek_save_credentials", { username, password });
}

export function soulseekLoadCredentials(): Promise<[string, string] | null> {
  return invoke<[string, string] | null>("soulseek_load_credentials");
}

export function soulseekClearSavedCredentials(): Promise<void> {
  return invoke<void>("soulseek_clear_saved_credentials");
}

export {
  clearSlskCoverCache,
  getSlskCoverDataUrl,
  peekSlskCover,
  getSlskCoverReactive,
  slskCoverKey,
} from "./coverCache.js";
