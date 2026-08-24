//! GAIA quasi-exact-match scoring, mirroring the official leaderboard
//! `scorer.py` (huggingface.co/spaces/gaia-benchmark/leaderboard).
//!
//! The branch is chosen by the GOLD answer, exactly as upstream:
//! 1. Number — the gold parses as a float *without* any stripping
//!    (Python `is_float(ground_truth)`). Only the prediction side strips
//!    `$`, `%`, and `,` before parsing.
//! 2. List — the gold contains `,` or `;`; elements are compared pairwise
//!    (order- and length-sensitive), each element re-dispatched as number or
//!    punctuation-preserving string.
//! 3. String — lowercased, all whitespace removed, ASCII punctuation removed.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScoreBranch {
    Number,
    List,
    Str,
}

impl ScoreBranch {
    pub fn as_str(self) -> &'static str {
        match self {
            ScoreBranch::Number => "number",
            ScoreBranch::List => "list",
            ScoreBranch::Str => "string",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScoreDetail {
    pub correct: bool,
    pub branch: ScoreBranch,
    pub normalized_prediction: String,
    pub normalized_gold: String,
}

pub fn score_answer(prediction: &str, gold: &str) -> bool {
    score_answer_detailed(prediction, gold).correct
}

pub fn score_answer_detailed(prediction: &str, gold: &str) -> ScoreDetail {
    // Branch gate parity with the official scorer: the gold must parse as a
    // float WITHOUT stripping ("1,234" is a list, not a number, upstream).
    if let Some(gold_number) = parse_plain_number(gold) {
        let prediction_number = normalize_number(prediction);
        return ScoreDetail {
            correct: prediction_number.is_some_and(|prediction| prediction == gold_number),
            branch: ScoreBranch::Number,
            normalized_prediction: render_number(prediction_number),
            normalized_gold: render_number(Some(gold_number)),
        };
    }
    if gold.contains(',') || gold.contains(';') {
        let prediction_items = split_list(prediction);
        let gold_items = split_list(gold);
        let correct = prediction_items.len() == gold_items.len()
            && prediction_items
                .iter()
                .zip(&gold_items)
                .all(|(prediction_item, gold_item)| {
                    if let Some(gold_number) = parse_plain_number(gold_item) {
                        normalize_number(prediction_item)
                            .is_some_and(|prediction| prediction == gold_number)
                    } else {
                        normalize_string(prediction_item, false)
                            == normalize_string(gold_item, false)
                    }
                });
        return ScoreDetail {
            correct,
            branch: ScoreBranch::List,
            normalized_prediction: render_list(&prediction_items),
            normalized_gold: render_list(&gold_items),
        };
    }
    let normalized_prediction = normalize_answer(prediction);
    let normalized_gold = normalize_answer(gold);
    ScoreDetail {
        correct: normalized_prediction == normalized_gold,
        branch: ScoreBranch::Str,
        normalized_prediction,
        normalized_gold,
    }
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

/// Gold-side gate: plain float parse, no stripping (Python `is_float`).
fn parse_plain_number(value: &str) -> Option<f64> {
    value.trim().parse::<f64>().ok()
}

/// Prediction-side normalization: strip `$`, `%`, `,` then parse (Python
/// `normalize_number_str`, minus the `float("inf")` sentinel — `None` here).
pub(super) fn normalize_number(value: &str) -> Option<f64> {
    value
        .replace(['$', '%', ','], "")
        .trim()
        .parse::<f64>()
        .ok()
}

/// Canonical form of one list element, matching the scorer's per-element
/// comparison: a plain-parseable element renders as its float, otherwise the
/// punctuation-preserving lowercased/whitespace-stripped string.
pub(super) fn normalize_element(value: &str) -> String {
    match parse_plain_number(value) {
        Some(number) => format!("n:{number}"),
        None => format!("s:{}", normalize_string(value, false)),
    }
}

fn render_number(value: Option<f64>) -> String {
    value.map_or_else(|| "unparseable".into(), |number| number.to_string())
}

fn render_list(items: &[&str]) -> String {
    items
        .iter()
        .map(|item| {
            normalize_number(item).map_or_else(
                || normalize_string(item, false),
                |number| number.to_string(),
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
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
        assert!(score_answer("50", "50%"));
        assert!(score_answer("-0.0", "0"));
        assert!(score_answer("$89,706.00", "89706.00"));
        assert!(score_answer("89706", "89706.00"));
        assert!(!score_answer("0.178", "0.1777"));
        assert!(!score_answer("90 participants", "90"));
        assert!(!score_answer("17 thousand hours", "17"));
    }

    #[test]
    fn gold_with_grouping_separator_is_a_list_not_a_number() {
        // Official parity: Python float("1,234") fails, so the gold takes the
        // LIST branch and "1234" (one element vs two) cannot match.
        let detail = score_answer_detailed("1234", "$1,234");
        assert_eq!(detail.branch, ScoreBranch::List);
        assert!(!detail.correct);
        assert_eq!(score_answer_detailed("1,234", "1,234").branch, ScoreBranch::List);
    }

    #[test]
    fn scores_strings_without_case_space_or_punctuation() {
        assert!(score_answer(" New York! ", "new york"));
        assert!(score_answer("THE CASTLE", "the castle"));
        assert!(score_answer("sea gull", "seagull"));
        assert!(score_answer("Saint Petersburg", "Saint Petersburg"));
        assert!(!score_answer("Saint Petersburg, Russia", "Saint Petersburg"));
        assert!(score_answer("FunkMonk", "funkmonk"));
        assert!(score_answer("80GSFC21M0002", "80GSFC21M0002"));
        assert!(score_answer("Guava.", "Guava"));
        assert!(score_answer("Right", "right"));
        assert!(score_answer("F478A7", "f478a7"));
        assert!(score_answer("Rd5", "rd5"));
        assert!(score_answer(
            "The seagull glided peacefully to my chair.",
            "The sea gull glided peacefully to my chair"
        ));
        assert!(!score_answer("NYC", "New York City"));
        assert!(!score_answer("2", "two"));
    }

    #[test]
    fn unicode_operators_survive_normalization() {
        // ASCII parens strip, Unicode logical operators must match exactly.
        assert!(score_answer("(¬A → B) ↔ (A ∨ ¬B)", "(¬A → B) ↔ (A ∨ ¬B)"));
        assert!(score_answer("¬A → B ↔ A ∨ ¬B", "(¬A → B) ↔ (A ∨ ¬B)"));
        assert!(!score_answer("(-A -> B) <-> (A v -B)", "(¬A → B) ↔ (A ∨ ¬B)"));
    }

    #[test]
    fn scores_lists_in_order_with_number_aware_elements() {
        assert!(score_answer("Paris; London", "paris, london"));
        assert!(score_answer("$1, 2%", "1;2"));
        assert!(score_answer("green, white", "green, white"));
        assert!(!score_answer("white, green", "green, white"));
        assert!(!score_answer("London, Paris", "paris, london"));
        assert!(score_answer("b, e", "b, e"));
        assert!(score_answer("Braintree, Honolulu", "Braintree, Honolulu"));
        assert!(score_answer(
            "cornstarch, freshly squeezed lemon juice, granulated sugar, pure vanilla extract, ripe strawberries",
            "cornstarch, freshly squeezed lemon juice, granulated sugar, pure vanilla extract, ripe strawberries"
        ));
        assert!(score_answer(
            "broccoli, celery, fresh basil, lettuce, sweet potatoes",
            "broccoli, celery, fresh basil, lettuce, sweet potatoes"
        ));
    }

    #[test]
    fn list_length_mismatch_is_an_instant_zero() {
        assert!(!score_answer("green, white, red", "green, white"));
        assert!(!score_answer("green", "green, white"));
        // A trailing "and" or period inside an element breaks the element.
        assert!(!score_answer("green and white", "green, white"));
    }

    #[test]
    fn gold_list_elements_gate_on_plain_parse() {
        // Official semantics: gold "$1" does NOT plain-parse, so it is a
        // punctuation-preserving string element — "1" != "$1".
        let detail = score_answer_detailed("1; 2", "$1; 2%");
        assert!(!detail.correct);
        assert_eq!(detail.branch, ScoreBranch::List);
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

    #[test]
    fn non_finite_predictions_do_not_match_finite_golds() {
        assert!(!score_answer("inf", "42"));
        assert!(!score_answer("NaN", "42"));
        // NaN never equals NaN, mirroring Python float("nan") comparison.
        assert!(!score_answer("NaN", "NaN"));
    }

    #[test]
    fn detailed_scoring_reports_branch_and_normalized_forms() {
        let number = score_answer_detailed("$89,706.00", "89706.00");
        assert_eq!(number.branch, ScoreBranch::Number);
        assert!(number.correct);
        assert_eq!(number.normalized_prediction, "89706");
        assert_eq!(number.normalized_gold, "89706");

        let list = score_answer_detailed("White, Green", "green, white");
        assert_eq!(list.branch, ScoreBranch::List);
        assert!(!list.correct);
        assert_eq!(list.normalized_prediction, "white, green");
        assert_eq!(list.normalized_gold, "green, white");

        let string = score_answer_detailed("The answer is Paris", "Paris");
        assert_eq!(string.branch, ScoreBranch::Str);
        assert!(!string.correct);
        assert_eq!(string.normalized_gold, "paris");
    }
}
