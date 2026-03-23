use encoding_rs::WINDOWS_1251;
use reqwest::Client;

use super::SearchResult;

// ── Music category filter ─────────────────────────────────────────────────────

const MUSIC_KEYWORDS: &[&str] = &[
    "музык",
    "lossless",
    "дискограф",
    "саундтрек",
    "soundtrack",
    // genre names used in Rutracker subforum titles
    "рок",
    "rock",
    "метал",
    "metal",
    "поп",
    "pop",
    "джаз",
    "jazz",
    "блюз",
    "blues",
    "панк",
    "punk",
    "шансон",
    "chanson",
    "электрон",
    "electronic",
    "классич",
    "classical",
    "фолк",
    "folk",
    "хип",
    "rap",
    "реп",
    "инди",
    "indie",
    "регги",
    "reggae",
    "alternative",
    "альтернатив",
    "отечествен",
    "зарубежн",
    "r&b",
    "soul",
    "соул",
];

const EXCLUDE_KEYWORDS: &[&str] = &["аудиокниг", "audiobook", "радиоспект"];

fn is_music_category(category: &str) -> bool {
    if category.is_empty() {
        // If we couldn't parse the category, include by default — the user's
        // query is specific enough (e.g. a band name) that false positives are fine.
        return true;
    }
    let lower = category.to_lowercase();
    if EXCLUDE_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
        return false;
    }
    MUSIC_KEYWORDS.iter().any(|kw| lower.contains(kw))
}

// ── Public API ────────────────────────────────────────────────────────────────

pub async fn search_music(
    client: &Client,
    base: &str,
    query: &str,
) -> Result<Vec<SearchResult>, String> {
    let url = format!("{}/forum/tracker.php", base);

    let resp = client
        .get(&url)
        .query(&[("nm", query)])
        .send()
        .await
        .map_err(|e| format!("Ошибка сети при поиске: {}", e))?;

    // Session expired → Rutracker redirects to login.php
    if resp.url().path().contains("login") {
        return Err("Сессия устарела — войдите снова.".into());
    }

    // Rutracker responds in Windows-1251; try UTF-8 first, fall back if needed
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Ошибка чтения ответа: {}", e))?;

    let html = if std::str::from_utf8(&bytes).is_ok() {
        String::from_utf8(bytes.to_vec()).unwrap()
    } else {
        let (cow, _, _) = WINDOWS_1251.decode(&bytes);
        cow.into_owned()
    };

    // phpBB login form has this specific input — much more reliable than checking
    // for any form + login.php link, which also appears on logged-in pages.
    if html.contains(r#"name="login_username""#) {
        return Err("Сессия устарела — войдите снова.".into());
    }

    let mut results = parse_results(&html);
    results.sort_by(|a, b| {
        b.seeders
            .cmp(&a.seeders)
            .then_with(|| b.leechers.cmp(&a.leechers))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(results)
}

// ── HTML parsing ──────────────────────────────────────────────────────────────
//
// Align row detection with neegde.ru (Cheerio): `tr.tCenter` and `tr.hl-tr` inside
// `#tor-tbl`. Topic id is taken from `viewtopic.php?t=…` — Rutracker no longer always
// emits `id="tr-{id}"` on `<tr>`, which used to make the old parser see zero rows.

/// Opening `<tr …>` tag for a tracker result row (header / spacer rows lack these classes).
fn tr_opening_is_result_row(open_tag: &str) -> bool {
    open_tag.contains("hl-tr") || open_tag.contains("tCenter")
}

/// First `viewtopic.php?t=NUM` (or `&amp;t=` in entity-encoded HTML) in the row.
fn extract_first_viewtopic_id(row: &str) -> Option<String> {
    let mut search = 0usize;
    while search < row.len() {
        let slice = &row[search..];
        let (rel, mlen) = ["viewtopic.php?t=", "viewtopic.php&amp;t="]
            .iter()
            .filter_map(|m| slice.find(*m).map(|p| (p, m.len())))
            .min_by_key(|(p, _)| *p)?;
        let after = &slice[rel + mlen..];
        let end = after
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(after.len());
        let id = &after[..end];
        if !id.is_empty() {
            return Some(id.to_string());
        }
        search += rel + 1;
    }
    None
}

fn parse_results(html: &str) -> Vec<SearchResult> {
    let mut out = Vec::new();

    // No results table → empty results, not an error
    if !html.contains("tor-tbl") {
        return out;
    }

    let mut pos = 0;

    while let Some(rel) = html[pos..].find("<tr") {
        let tr_start = pos + rel;
        let Some(gt_rel) = html[tr_start + 3..].find('>') else {
            break;
        };
        let tag_end = tr_start + 3 + gt_rel;
        let open_tag = &html[tr_start..=tag_end];

        if !tr_opening_is_result_row(open_tag) {
            pos = tag_end + 1;
            continue;
        }

        let row_end = html[tag_end + 1..]
            .find("</tr>")
            .map(|p| tag_end + 1 + p + 5)
            .unwrap_or(html.len());
        let row = &html[tr_start..row_end];

        let Some(topic_id) = extract_first_viewtopic_id(row) else {
            pos = row_end;
            continue;
        };

        if let Some(name) = extract_tlink(row) {
            let category = extract_class_text(row, "gen-f").unwrap_or_default();
            if is_music_category(&category) {
                out.push(SearchResult {
                    id: topic_id,
                    name,
                    category,
                    size: extract_tor_size(row),
                    seeders: extract_peer_count(row, "seedmed"),
                    leechers: extract_peer_count(row, "leechmed"),
                    added: extract_class_text(row, "tRight").unwrap_or_else(|| "—".into()),
                    source: "rutracker".to_string(),
                });
            }
        }

        pos = row_end;
        if pos >= html.len() {
            break;
        }
    }

    out
}

/// Extract text content of the first `<a class="tLink">` anchor (torrent title).
fn extract_tlink(row: &str) -> Option<String> {
    extract_class_text(row, "tLink")
}

/// Extract text content of the first element that has `class_name` as one of
/// its CSS classes (handles both single-class `class="foo"` and multi-class
/// `class="foo bar"` attributes).
fn extract_class_text(row: &str, class_name: &str) -> Option<String> {
    let mut search_from = 0;
    loop {
        let rel = row[search_from..].find("class=\"")?;
        let val_start = search_from + rel + 7; // skip 'class="'
        let val_end = val_start + row[val_start..].find('"')?;
        let classes = &row[val_start..val_end];

        let has = classes == class_name
            || classes.starts_with(&format!("{} ", class_name))
            || classes.ends_with(&format!(" {}", class_name))
            || classes.contains(&format!(" {} ", class_name));

        if has {
            let after = &row[val_end + 1..];
            let gt = after.find('>')?;
            let content = &after[gt + 1..];
            let lt = content.find('<')?;
            let text = content[..lt].trim();
            if !text.is_empty() {
                return Some(decode_entities(text));
            }
        }

        search_from = val_end + 1;
        if search_from >= row.len() {
            return None;
        }
    }
}

/// Extract raw byte count from `<td class="tor-size"><u>BYTES</u></td>`.
fn extract_tor_size(row: &str) -> u64 {
    let Some(pos) = row.find("class=\"tor-size\"") else {
        return 0;
    };
    let after = &row[pos..];
    let Some(u_start) = after.find("<u>") else { return 0 };
    let inner = &after[u_start + 3..];
    let Some(u_end) = inner.find("</u>") else { return 0 };
    inner[..u_end].trim().parse().unwrap_or(0)
}

/// True if `class_list` is a space-separated CSS class attribute value containing `token`.
fn class_list_has_token(class_list: &str, token: &str) -> bool {
    class_list
        .split_whitespace()
        .any(|p| p.eq_ignore_ascii_case(token))
}

/// `class_start` = index of `c` in `class=`. Returns byte range `[start, end)` of the quoted value.
fn class_attr_value_at(row: &str, class_start: usize) -> Option<(usize, usize)> {
    let mut i = class_start + "class".len();
    if row.as_bytes().get(i) != Some(&b'=') {
        return None;
    }
    i += 1;
    while i < row.len() && row.as_bytes()[i].is_ascii_whitespace() {
        i += 1;
    }
    let q = *row.as_bytes().get(i)? as char;
    if q != '"' && q != '\'' {
        return None;
    }
    let val_start = i + 1;
    let close = val_start + row[val_start..].find(q)?;
    Some((val_start, close))
}

/// Name of an opening HTML tag: `<td ...` → `td`, `<b ...` → `b`.
fn opening_tag_name(row: &str, lt_idx: usize) -> Option<&str> {
    let mut i = lt_idx + 1;
    if row.as_bytes().get(i) == Some(&b'/') {
        return None;
    }
    let start = i;
    while i < row.len() {
        let c = row.as_bytes()[i];
        if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' || c == b'>' {
            break;
        }
        i += 1;
    }
    if i == start {
        return None;
    }
    row.get(start..i)
}

/// End index of `>` for the opening tag that starts at `lt_idx`.
fn opening_tag_gt(row: &str, lt_idx: usize) -> Option<usize> {
    row[lt_idx..].find('>').map(|p| lt_idx + p)
}

/// Digits-only parse (handles `1 234`, `&nbsp;5`, markup noise in fragment).
fn parse_u64_loose(s: &str) -> Option<u64> {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// First `<b>...</b>` text inside `fragment` (handles `<b class="…">`).
fn first_b_text(fragment: &str) -> Option<String> {
    let i = fragment.find("<b")?;
    let tail = &fragment[i..];
    let gt = tail.find('>')?;
    let inner = &tail[gt + 1..];
    let end = inner.find("</b>")?;
    let t = inner[..end].trim();
    if t.is_empty() {
        return None;
    }
    Some(decode_entities(t))
}

/// Seed/leech count: same idea as neegde.ru `td.seedmed b, b.seedmed` — supports
/// `<td class="seedmed"><b>n</b>` and `<b class="seedmed">n</b>` (the old parser missed the latter).
fn extract_peer_count(row: &str, class_token: &str) -> u64 {
    let mut search = 0usize;
    while let Some(rel) = row[search..].find("class=") {
        let class_eq = search + rel;
        let Some((val_start, val_end)) = class_attr_value_at(row, class_eq) else {
            search = class_eq + 6;
            continue;
        };
        let classes = row.get(val_start..val_end).unwrap_or("");
        if !class_list_has_token(classes, class_token) {
            search = val_end + 1;
            continue;
        }
        let Some(lt) = row[..class_eq].rfind('<') else {
            break;
        };
        let Some(gt) = opening_tag_gt(row, lt) else {
            search = val_end + 1;
            continue;
        };
        let Some(tag) = opening_tag_name(row, lt) else {
            search = val_end + 1;
            continue;
        };

        let content_start = gt + 1;
        let content_end = if tag.eq_ignore_ascii_case("b") {
            row[content_start..]
                .find("</b>")
                .map(|p| content_start + p)
                .unwrap_or(row.len())
        } else if tag.eq_ignore_ascii_case("td") {
            row[content_start..]
                .find("</td>")
                .map(|p| content_start + p)
                .unwrap_or(row.len())
        } else {
            search = val_end + 1;
            continue;
        };

        let fragment = &row[content_start..content_end];

        if let Some(bt) = first_b_text(fragment) {
            if let Some(n) = parse_u64_loose(&bt) {
                return n;
            }
        }
        if let Some(n) = parse_u64_loose(fragment) {
            return n;
        }

        search = val_end + 1;
    }
    0
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_count_td_wraps_b() {
        let row = r#"<tr><td class="seedmed"><b>12</b></td></tr>"#;
        assert_eq!(extract_peer_count(row, "seedmed"), 12);
    }

    #[test]
    fn peer_count_b_has_class() {
        let row = r#"<tr><td><b class="seedmed">34</b></td></tr>"#;
        assert_eq!(extract_peer_count(row, "seedmed"), 34);
    }

    #[test]
    fn peer_count_td_b_with_attr() {
        let row = r#"<tr><td class="seedmed"><b class="x">56</b></td></tr>"#;
        assert_eq!(extract_peer_count(row, "seedmed"), 56);
    }
}
