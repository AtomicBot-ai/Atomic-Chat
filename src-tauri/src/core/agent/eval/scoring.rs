pub fn score_answer(prediction: &str, gold: &str) -> bool {
    if let Some(gold_number) = normalize_number(gold) {
        return normalize_number(prediction).is_some_and(|prediction| prediction == gold_number);
    }
    if gold.contains(',') || gold.contains(';') {
        let prediction_items = split_list(prediction);
        let gold_items = split_list(gold);
        if prediction_items.len() != gold_items.len() {
            return false;
        }
        return prediction_items
            .into_iter()
            .zip(gold_items)
            .all(|(prediction_item, gold_item)| {
                if let Some(gold_number) = normalize_number(gold_item) {
                    normalize_number(prediction_item)
                        .is_some_and(|prediction| prediction == gold_number)
                } else {
                    normalize_string(prediction_item, false) == normalize_string(gold_item, false)
                }
            });
    }
    normalize_answer(prediction) == normalize_answer(gold)
}

pub fn normalize_answer(value: &str) -> String {
    normalize_string(value, true)
}

fn normalize_string(value: &str, remove_punctuation: bool) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|character| {
            !character.is_whitespace() && (!remove_punctuation || !character.is_ascii_punctuation())
        })
        .collect()
}

fn normalize_number(value: &str) -> Option<f64> {
    value
        .replace(['$', '%', ','], "")
        .trim()
        .parse::<f64>()
        .ok()
}

fn split_list(value: &str) -> Vec<&str> {
    value.split([',', ';']).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_numbers_with_grouping_and_decimal_equivalence() {
        assert!(score_answer("1,234.00", "1234"));
        assert!(score_answer("1234", "$1,234"));
        assert!(score_answer("50", "50%"));
        assert!(score_answer("-0.0", "0"));
    }

    #[test]
    fn scores_strings_without_case_space_or_punctuation() {
        assert!(score_answer(" New York! ", "new york"));
    }

    #[test]
    fn scores_lists_in_order_with_number_aware_elements() {
        assert!(score_answer("Paris; London", "paris, london"));
        assert!(score_answer("$1, 2%", "1;2"));
        assert!(score_answer("1; 2", "$1; 2%"));
        assert!(!score_answer("London, Paris", "paris, london"));
    }

    #[test]
    fn preserves_punctuation_when_scoring_list_elements() {
        assert!(score_answer("A.; B", "a.;b"));
        assert!(!score_answer("A; B", "a.;b"));
    }

    #[test]
    fn rejects_wrong_answers() {
        assert!(!score_answer("41", "42"));
        assert!(!score_answer("A, B", "A, C"));
    }
}
