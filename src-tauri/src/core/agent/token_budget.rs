//! Prompt token budgeting aligned with the standalone `atomic-agent`.

pub const COMPLETION_MAX_TOKENS: u32 = 8_192;
/// Thinking tokens reserved for an uncapped level (`max`). The reservation
/// must be finite so the prompt and the completion can be sized to fit
/// `n_ctx`, so it is the top finite tier the web-app sends (`xhigh`), and the
/// sampler budget itself stays uncapped: `max` keeps the headroom of `xhigh`
/// and still thinks past it, into the tool-call budget, when the model does.
pub const UNCAPPED_THINKING_RESERVE_TOKENS: u32 = 8_192;
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

/// Thinking tokens to reserve on top of the tool-call budget for a turn that
/// thinks. The thinking block and the tool-call array share one completion
/// budget on every transport (`n_predict` on llama.cpp, `max_tokens` on chat
/// endpoints), so without this reserve a full thinking block leaves nothing
/// for the array.
pub fn thinking_reserve_tokens(budget_tokens: Option<u32>) -> u32 {
    budget_tokens.unwrap_or(UNCAPPED_THINKING_RESERVE_TOKENS)
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
    fn thinking_reserve_is_the_budget_or_the_top_finite_tier() {
        assert_eq!(thinking_reserve_tokens(Some(256)), 256);
        assert_eq!(thinking_reserve_tokens(Some(8_192)), 8_192);
        assert_eq!(thinking_reserve_tokens(None), 8_192);
    }

    #[test]
    fn effective_cap_shrinks_by_the_thinking_reserve() {
        let tool_call_only =
            compute_effective_conversation_cap(32_000, Some(32_768), 2_000, COMPLETION_MAX_TOKENS);
        let with_thinking = compute_effective_conversation_cap(
            32_000,
            Some(32_768),
            2_000,
            COMPLETION_MAX_TOKENS + thinking_reserve_tokens(None),
        );
        assert_eq!(tool_call_only, 22_064);
        assert_eq!(with_thinking, 13_872);
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
