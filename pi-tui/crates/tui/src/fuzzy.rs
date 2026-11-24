//! Small dependency-free fuzzy matcher for completion lists.

/// Score a case-insensitive subsequence match.
///
/// Higher scores prefer adjacent matches and matches at word/path starts;
/// gaps and unnecessarily long candidates are mildly penalized.
pub(crate) fn score(query: &str, candidate: &str) -> Option<i64> {
    let needle: Vec<char> = query.chars().flat_map(char::to_lowercase).collect();
    if needle.is_empty() {
        return Some(0);
    }

    let mut needle_idx = 0;
    let mut total = 0i64;
    let mut previous_match = None;
    let mut previous_char: Option<char> = None;

    for (idx, ch) in candidate.chars().enumerate() {
        let char_count = idx + 1;
        let mut lower = ch.to_lowercase();
        let matches = lower.next() == Some(needle[needle_idx]) && lower.next().is_none();
        if matches {
            let word_start = idx == 0
                || previous_char.is_some_and(|c| {
                    !c.is_alphanumeric() || (c.is_lowercase() && ch.is_uppercase())
                });
            total += 10;
            if word_start {
                total += 18;
            }
            if previous_match == idx.checked_sub(1) {
                total += 24;
            }
            total -= idx as i64;

            previous_match = Some(idx);
            needle_idx += 1;
            if needle_idx == needle.len() {
                return Some(total - (char_count.saturating_sub(needle.len()) as i64));
            }
        }
        previous_char = Some(ch);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::score;

    #[test]
    fn rejects_non_subsequence() {
        assert_eq!(score("xyz", "src/app.rs"), None);
    }

    #[test]
    fn consecutive_matches_rank_higher() {
        assert!(score("abc", "abc.txt") > score("abc", "a_b_c.txt"));
    }

    #[test]
    fn word_starts_rank_higher() {
        assert!(score("fb", "foo/bar.rs") > score("fb", "foobar.rs"));
    }
}
