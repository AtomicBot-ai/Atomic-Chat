//! JSON-Schema counterpart of [`super::grammar`] for OpenAI-compatible
//! transports.
//!
//! llama.cpp constrains tool calls with GBNF during sampling. Chat transports
//! have no equivalent, but many of them honour
//! `response_format: {"type": "json_schema"}`. This module renders the same
//! contract — an array of `{tool, args}` objects — as a JSON Schema.
//!
//! The schema deliberately pins only the **shape** and the **tool-name enum**,
//! not per-tool argument types. A 36-branch `oneOf` compiles slowly in
//! outlines/llguidance and is rejected outright by several providers, while
//! argument shape is already covered twice over: the prompt carries each
//! tool's `args_schema` (see [`super::prompt::ITERATION_ONE_TOOLS`]) and
//! `tools::authorize_call` validates before dispatch.
//!
//! The tool-name set is derived from [`GRAMMAR_TOOL_NAMES`] so the two
//! constrained-decoding paths cannot drift; `json_schema_covers_every_grammar_tool_name`
//! enforces it.

use serde_json::{json, Value};

use super::grammar::GRAMMAR_TOOL_NAMES;
use super::runner::MAX_PARALLEL_TOOL_CALLS;
use super::skills::SkillRegistry;

/// `json_schema.name` sent to the provider. Stable across turns.
pub const TOOL_SCHEMA_NAME: &str = "atomic_agent_tool_calls";

/// Tools the model may name this turn.
///
/// Mirrors the runtime behaviour of `tool_call_grammar_for_profile`, which only
/// stitches the skill rules in when the registry has at least one enabled
/// skill — naming a skill tool with no skills loaded is always an error, so it
/// stays out of the enum.
pub fn schema_tool_names(skill_registry: &SkillRegistry) -> Vec<&'static str> {
    let has_skills = skill_registry.enabled().next().is_some();
    GRAMMAR_TOOL_NAMES
        .iter()
        .copied()
        .filter(|name| has_skills || !matches!(*name, "skill.view" | "skill.run_script"))
        .collect()
}

/// The bare schema: an array of `{tool, args}` objects.
pub fn tool_call_json_schema(skill_registry: &SkillRegistry) -> Value {
    json!({
        "type": "array",
        "minItems": 1,
        "maxItems": MAX_PARALLEL_TOOL_CALLS,
        "items": {
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "enum": schema_tool_names(skill_registry),
                },
                "args": {
                    "type": "object",
                    "additionalProperties": true,
                },
            },
            "required": ["tool", "args"],
            "additionalProperties": false,
        },
    })
}

/// The schema wrapped in an OpenAI `response_format` envelope.
///
/// `strict` is false: strict mode requires every property to be `required` and
/// `additionalProperties: false` all the way down, which the open-ended `args`
/// object cannot satisfy.
pub fn tool_call_response_format(skill_registry: &SkillRegistry) -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": TOOL_SCHEMA_NAME,
            "strict": false,
            "schema": tool_call_json_schema(skill_registry),
        },
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::core::agent::prompt::ITERATION_ONE_TOOLS;

    fn registry_with(names: &[&str]) -> (TempDir, SkillRegistry) {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        for name in names {
            let skill = root.join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(
                skill.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: Test\n---\nBody"),
            )
            .unwrap();
        }
        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap();
        (temp, registry)
    }

    fn enum_names(schema: &Value) -> Vec<String> {
        schema
            .pointer("/items/properties/tool/enum")
            .and_then(Value::as_array)
            .expect("tool enum")
            .iter()
            .map(|value| value.as_str().expect("enum entry is a string").to_owned())
            .collect()
    }

    /// The GBNF and JSON-Schema catalogs must name exactly the same tools, and
    /// both must map onto the prompt catalog. This is the JSON-Schema twin of
    /// `grammar::tests::grammar_covers_every_iteration_one_tool`.
    #[test]
    fn json_schema_covers_every_grammar_tool_name() {
        let (_temp, registry) = registry_with(&["pdf"]);
        let names = schema_tool_names(&registry);

        for name in GRAMMAR_TOOL_NAMES {
            assert!(
                names.contains(name),
                "json schema is missing tool `{name}` present in GRAMMAR_TOOL_NAMES"
            );
        }
        for name in &names {
            assert!(
                ITERATION_ONE_TOOLS.iter().any(|d| &d.name == name),
                "json schema advertises `{name}` with no matching ITERATION_ONE_TOOLS descriptor"
            );
        }
        assert_eq!(names.len(), GRAMMAR_TOOL_NAMES.len());
        assert_eq!(names.len(), ITERATION_ONE_TOOLS.len());
    }

    #[test]
    fn json_schema_drops_skill_tools_without_enabled_skills() {
        let (_temp, registry) = registry_with(&[]);
        let names = schema_tool_names(&registry);

        assert!(!names.contains(&"skill.view"));
        assert!(!names.contains(&"skill.run_script"));
        assert_eq!(names.len(), GRAMMAR_TOOL_NAMES.len() - 2);
    }

    #[test]
    fn json_schema_enum_matches_the_tool_name_list_exactly() {
        let (_temp, registry) = registry_with(&["pdf"]);
        let schema = tool_call_json_schema(&registry);
        assert_eq!(enum_names(&schema), schema_tool_names(&registry));
    }

    /// The runtime clamps a batch at `MAX_PARALLEL_TOOL_CALLS`, so the schema
    /// may as well reject the over-long array during sampling.
    #[test]
    fn json_schema_max_items_matches_the_runner_batch_limit() {
        let (_temp, registry) = registry_with(&[]);
        let schema = tool_call_json_schema(&registry);
        assert_eq!(schema["maxItems"], json!(MAX_PARALLEL_TOOL_CALLS));
        assert_eq!(schema["minItems"], json!(1));
        assert_eq!(schema["type"], json!("array"));
    }

    #[test]
    fn response_format_wraps_the_schema_under_a_stable_name() {
        let (_temp, registry) = registry_with(&[]);
        let format = tool_call_response_format(&registry);

        assert_eq!(format["type"], json!("json_schema"));
        assert_eq!(format["json_schema"]["name"], json!(TOOL_SCHEMA_NAME));
        assert_eq!(format["json_schema"]["strict"], json!(false));
        assert_eq!(
            format["json_schema"]["schema"],
            tool_call_json_schema(&registry)
        );
    }
}
