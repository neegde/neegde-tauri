/**
 * Parse a plain-text "Artist - Track" import file.
 *
 * Format:
 *   One track per line: "Исполнитель - Название трека"
 *   Empty lines and lines starting with # or // are skipped.
 *   First " - " is the separator (so "A - B - C" → artist="A", title="B - C").
 */

export interface ParsedTrack {
  artist: string;
  title: string;
  raw: string;
  lineNum: number;
}

export function parseImportText(text: string): ParsedTrack[] {
  const lines = text.split(/\r?\n/);
  const result: ParsedTrack[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) continue;

    // First occurrence of " - " is the artist/title separator
    const sep = raw.indexOf(" - ");
    if (sep === -1) continue;

    const artist = raw.slice(0, sep).trim();
    const title = raw.slice(sep + 3).trim();
    if (!artist || !title) continue;

    result.push({ artist, title, raw, lineNum: i + 1 });
  }

  return result;
}
