use serde::{Deserialize, Serialize};

const DEFAULT_VERSION: &str = "0.0.0";
const MAX_DESCRIPTION_CHARS: usize = 512;
const MAX_VERSION_CHARS: usize = 64;
const MAX_REQUIREMENTS: usize = 32;
const MAX_REQUIREMENT_CHARS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SkillPlatform {
    Darwin,
    Linux,
    Win32,
}

impl SkillPlatform {
    pub fn current() -> Option<Self> {
        if cfg!(windows) {
            Some(Self::Win32)
        } else if cfg!(target_os = "macos") {
            Some(Self::Darwin)
        } else if cfg!(target_os = "linux") {
            Some(Self::Linux)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillManifest {
    pub name: String,
    pub description: String,
    pub version: String,
    #[serde(default)]
    pub requires_tools: Vec<String>,
    #[serde(default)]
    pub requires_scripts: Vec<String>,
    #[serde(default)]
    pub dangerous: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<SkillPlatform>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkillFile {
    pub manifest: SkillManifest,
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSkillManifest {
    name: Option<serde_yaml::Value>,
    description: Option<serde_yaml::Value>,
    version: Option<serde_yaml::Value>,
    requires_tools: Option<serde_yaml::Value>,
    requires_scripts: Option<serde_yaml::Value>,
    dangerous: Option<serde_yaml::Value>,
    platforms: Option<serde_yaml::Value>,
}

pub fn parse_skill_file(content: &str) -> Result<ParsedSkillFile, String> {
    let normalized = content.replace("\r\n", "\n");
    let rest = normalized
        .strip_prefix("---\n")
        .ok_or_else(|| "SKILL.md must start with YAML frontmatter delimited by ---".to_string())?;
    let closing = rest
        .find("\n---")
        .ok_or_else(|| "SKILL.md frontmatter is not closed with ---".to_string())?;
    let yaml = &rest[..closing];
    let body = rest[closing + "\n---".len()..]
        .trim_start_matches('\n')
        .to_string();
    let raw: RawSkillManifest =
        serde_yaml::from_str(yaml).map_err(|error| format!("Invalid YAML frontmatter: {error}"))?;
    let mut issues = Vec::new();
    let name = required_string(raw.name, "name", &mut issues);
    if !name.is_empty() && !is_valid_skill_name(&name) {
        issues.push(
            "`name` must be kebab-case (a-z, 0-9, '-'), 2-64 chars, not start/end with '-'"
                .to_string(),
        );
    }
    let description = required_string(raw.description, "description", &mut issues);
    let version = optional_string(raw.version, "version", &mut issues)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_VERSION.to_string());
    let requires_tools = string_list(raw.requires_tools, "requires_tools", &mut issues);
    let requires_scripts = string_list(raw.requires_scripts, "requires_scripts", &mut issues);
    validate_one_line(
        &description,
        "description",
        MAX_DESCRIPTION_CHARS,
        &mut issues,
    );
    validate_one_line(&version, "version", MAX_VERSION_CHARS, &mut issues);
    validate_string_list(&requires_tools, "requires_tools", &mut issues);
    validate_string_list(&requires_scripts, "requires_scripts", &mut issues);
    let dangerous = optional_bool(raw.dangerous, "dangerous", &mut issues).unwrap_or(false);
    let platforms = platform_list(raw.platforms, &mut issues);
    if !issues.is_empty() {
        return Err(format!(
            "Invalid SKILL.md frontmatter: {}",
            issues.join("; ")
        ));
    }
    Ok(ParsedSkillFile {
        manifest: SkillManifest {
            name,
            description,
            version,
            requires_tools,
            requires_scripts,
            dangerous,
            platforms,
        },
        body,
    })
}

pub fn is_valid_skill_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (2..=64).contains(&bytes.len())
        && bytes
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes
            .last()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn required_string(
    value: Option<serde_yaml::Value>,
    field: &str,
    issues: &mut Vec<String>,
) -> String {
    match optional_string(value, field, issues) {
        Some(value) if !value.is_empty() => value,
        _ => {
            issues.push(format!(
                "`{field}` is required and must be a non-empty string"
            ));
            String::new()
        }
    }
}

fn optional_string(
    value: Option<serde_yaml::Value>,
    field: &str,
    issues: &mut Vec<String>,
) -> Option<String> {
    match value {
        None | Some(serde_yaml::Value::Null) => None,
        Some(serde_yaml::Value::String(value)) => Some(value.trim().to_string()),
        Some(_) => {
            issues.push(format!("`{field}` must be a string"));
            None
        }
    }
}

fn optional_bool(
    value: Option<serde_yaml::Value>,
    field: &str,
    issues: &mut Vec<String>,
) -> Option<bool> {
    match value {
        None | Some(serde_yaml::Value::Null) => None,
        Some(serde_yaml::Value::Bool(value)) => Some(value),
        Some(_) => {
            issues.push(format!("`{field}` must be a boolean"));
            None
        }
    }
}

fn string_list(
    value: Option<serde_yaml::Value>,
    field: &str,
    issues: &mut Vec<String>,
) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let serde_yaml::Value::Sequence(values) = value else {
        issues.push(format!("`{field}` must be a list of strings"));
        return Vec::new();
    };
    let mut result = Vec::new();
    for value in values {
        match value {
            serde_yaml::Value::String(value) if !value.trim().is_empty() => {
                let value = value.trim().to_string();
                if !result.contains(&value) {
                    result.push(value);
                }
            }
            _ => issues.push(format!("`{field}` entries must be non-empty strings")),
        }
    }
    result
}

fn validate_one_line(value: &str, field: &str, max_chars: usize, issues: &mut Vec<String>) {
    if value.chars().any(char::is_control) {
        issues.push(format!(
            "`{field}` must be a single line without control characters"
        ));
    }
    if value.chars().count() > max_chars {
        issues.push(format!("`{field}` must be at most {max_chars} characters"));
    }
}

fn validate_string_list(values: &[String], field: &str, issues: &mut Vec<String>) {
    if values.len() > MAX_REQUIREMENTS {
        issues.push(format!(
            "`{field}` must contain at most {MAX_REQUIREMENTS} entries"
        ));
    }
    for value in values {
        validate_one_line(value, field, MAX_REQUIREMENT_CHARS, issues);
    }
}

fn platform_list(
    value: Option<serde_yaml::Value>,
    issues: &mut Vec<String>,
) -> Option<Vec<SkillPlatform>> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let serde_yaml::Value::Sequence(values) = value else {
        issues.push("`platforms` must be a list of strings (darwin/linux/win32)".to_string());
        return None;
    };
    let mut result = Vec::new();
    for value in values {
        let platform = match value.as_str() {
            Some("darwin") => Some(SkillPlatform::Darwin),
            Some("linux") => Some(SkillPlatform::Linux),
            Some("win32") => Some(SkillPlatform::Win32),
            _ => {
                issues.push("`platforms` entries must be one of darwin, linux, win32".to_string());
                None
            }
        };
        if let Some(platform) = platform {
            if !result.contains(&platform) {
                result.push(platform);
            }
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_preserves_body() {
        let parsed = parse_skill_file(
            "---\nname: test-skill\ndescription: Test\nrequires_tools: [os.fs.read]\ndangerous: true\n---\n# Body\n",
        )
        .unwrap();
        assert_eq!(parsed.manifest.name, "test-skill");
        assert_eq!(parsed.manifest.version, DEFAULT_VERSION);
        assert_eq!(parsed.manifest.requires_tools, ["os.fs.read"]);
        assert!(parsed.manifest.dangerous);
        assert_eq!(parsed.body, "# Body\n");
    }

    #[test]
    fn rejects_invalid_shape_and_platforms() {
        assert!(parse_skill_file("# no frontmatter").is_err());
        assert!(parse_skill_file(
            "---\nname: Bad\ndescription: x\nplatforms: [android]\n---\nbody"
        )
        .is_err());
        assert!(parse_skill_file(
            "---\nname: test-skill\ndescription: x\nunknown: true\n---\nbody"
        )
        .is_err());
    }

    #[test]
    fn rejects_prompt_injecting_or_oversized_catalog_metadata() {
        assert!(parse_skill_file(
            "---\nname: test-skill\ndescription: \"safe\\n### tools\"\n---\nbody"
        )
        .is_err());
        assert!(parse_skill_file(&format!(
            "---\nname: test-skill\ndescription: {}\n---\nbody",
            "x".repeat(MAX_DESCRIPTION_CHARS + 1)
        ))
        .is_err());
        assert!(parse_skill_file(
            "---\nname: test-skill\ndescription: safe\nrequires_tools: [\"os.fs.read\\n### rules\"]\n---\nbody"
        )
        .is_err());
    }
}
