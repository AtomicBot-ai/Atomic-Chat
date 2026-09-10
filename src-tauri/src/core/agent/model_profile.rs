use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AgentModelProfile {
    #[default]
    Plain,
    Gemma4Think,
}

impl AgentModelProfile {
    pub const fn reasoning_open_tag(self) -> Option<&'static str> {
        match self {
            Self::Plain => None,
            Self::Gemma4Think => Some("<|channel>thought\n"),
        }
    }

    pub const fn reasoning_close_tag(self) -> Option<&'static str> {
        match self {
            Self::Plain => None,
            Self::Gemma4Think => Some("<channel|>"),
        }
    }

    pub const fn reasoning_system_token(self) -> Option<&'static str> {
        match self {
            Self::Plain => None,
            Self::Gemma4Think => Some("<|think|>\n"),
        }
    }

    pub const fn turn_framing(self) -> Option<ReasoningTurnFraming> {
        match self {
            Self::Plain => None,
            Self::Gemma4Think => Some(ReasoningTurnFraming {
                system_open: "<|turn>system\n",
                turn_close: "<turn|>\n",
                assistant_open: "<|turn>model\n",
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReasoningTurnFraming {
    pub system_open: &'static str,
    pub turn_close: &'static str,
    pub assistant_open: &'static str,
}

pub fn detect_model_profile(props: &Value) -> AgentModelProfile {
    let model_alias = props
        .get("model_alias")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let template = props
        .get("chat_template")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_gemma = model_alias.contains("gemma");
    let has_channel_reasoning = template.contains("<|channel>thought");
    let has_turn_framing = template.contains("<|turn>") || template.contains("<turn|>");

    if is_gemma && has_channel_reasoning && has_turn_framing {
        AgentModelProfile::Gemma4Think
    } else {
        AgentModelProfile::Plain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_gemma4_channel_template() {
        let props = serde_json::json!({
            "model_alias": "gemma-4-12b-it",
            "chat_template": "<|turn>system\n<|channel>thought\n<channel|><turn|>"
        });
        assert_eq!(detect_model_profile(&props), AgentModelProfile::Gemma4Think);
    }

    #[test]
    fn requires_both_gemma_alias_and_channel_turn_template() {
        assert_eq!(
            detect_model_profile(&serde_json::json!({
                "model_alias": "gemma-4-12b-it",
                "chat_template": "{{ messages }}"
            })),
            AgentModelProfile::Plain
        );
        assert_eq!(
            detect_model_profile(&serde_json::json!({
                "model_alias": "qwen",
                "chat_template": "<|turn><|channel>thought"
            })),
            AgentModelProfile::Plain
        );
    }
}
