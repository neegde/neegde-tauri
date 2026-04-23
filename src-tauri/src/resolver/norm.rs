/// Normalize a string for dedup — lowercase, keep only alphanumerics.
/// Unicode-aware (Cyrillic, CJK, accented Latin all pass through via
/// `char::is_alphanumeric`), so "Пошлая Молли" and "пошлаямолли" collapse
/// to the same key while "Pink Floyd" and "pinkfloyd" also do.
pub fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::norm;

    #[test]
    fn strips_non_alnum_and_lowercases() {
        assert_eq!(norm("Pink Floyd"), "pinkfloyd");
        assert_eq!(norm("The Wall [1979]"), "thewall1979");
    }

    #[test]
    fn keeps_cyrillic() {
        assert_eq!(norm("Пошлая Молли"), "пошлаямолли");
    }

    #[test]
    fn collapses_whitespace_and_punct() {
        assert_eq!(
            norm("Radiohead - Paranoid Android (OK Computer, 1997)"),
            "radioheadparanoidandroidokcomputer1997",
        );
    }
}
