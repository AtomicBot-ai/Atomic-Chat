//! Prompt token budgeting aligned with the standalone `atomic-agent`.

pub const COMPLETION_MAX_TOKENS: u32 = 8_192;
pub const CONFIGURED_CONVERSATION_CAP: usize = 32_000;
pub const CONVERSATION_CAP_SAFETY_MARGIN: usize = 512;
pub const CONVERSATION_CAP_FLOOR: usize = 512;

pub fn estimate_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let chars = text.chars().count();
    let words = text.split_whitespace().count().max(1);
    let char_based = ((chars as f64) / 3.6).ceil() as usize;
    let word_based = ((words as f64) * 1.4).ceil() as usize;
    char_based.max(word_based)
}

pub fn compute_effective_conversation_cap(
    configured_cap: usize,
    context_window: Option<usize>,
    fixed_tokens: usize,
    completion_max_tokens: u32,
) -> usize {
    let Some(context_window) = context_window.filter(|value| *value > 0) else {
        return configured_cap.max(CONVERSATION_CAP_FLOOR);
    };
    let available = context_window
        .saturating_sub(fixed_tokens)
        .saturating_sub(completion_max_tokens as usize)
        .saturating_sub(CONVERSATION_CAP_SAFETY_MARGIN);
    configured_cap.min(available).max(CONVERSATION_CAP_FLOOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimator_matches_atomic_agent_formula() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("one two"), 3);
        assert_eq!(estimate_tokens(&"x".repeat(36)), 10);
    }

    #[test]
    fn effective_cap_uses_configured_cap_without_props() {
        assert_eq!(
            compute_effective_conversation_cap(32_000, None, 4_000, 8_192),
            32_000
        );
    }

    #[test]
    fn effective_cap_reserves_completion_and_safety_margin() {
        assert_eq!(
            compute_effective_conversation_cap(32_000, Some(16_384), 2_000, 8_192),
            5_680
        );
        assert_eq!(
            compute_effective_conversation_cap(32_000, Some(8_192), 8_000, 8_192),
            512
        );
    }
}
