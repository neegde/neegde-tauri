import { BoundedHistory } from "./BoundedHistory.js";

const store = new BoundedHistory<string>({
  storageKey: "neegde.searchHistory.v1",
  max: 15,
  keyOf: (s) => s,
  isValid: (v): v is string => typeof v === "string",
});

export function loadSearchHistory(): string[] {
  return store.load();
}

export function addToSearchHistory(query: string): string[] {
  if (!query?.trim()) return store.load();
  return store.add(query.trim());
}

/** Removes one query string from saved search history. */
export function removeFromSearchHistory(query: string): string[] {
  return store.remove(query);
}
