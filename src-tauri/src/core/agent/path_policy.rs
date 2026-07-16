use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

use super::types::{ApprovalResource, ToolCallPayload};

#[derive(Debug)]
pub struct PreparedPaths {
    pub call: ToolCallPayload,
    pub resources: Vec<ApprovalResource>,
    pub escaped_root: bool,
}

pub async fn prepare_call_paths(
    call: &ToolCallPayload,
    working_dir: &Path,
) -> Result<PreparedPaths, String> {
    let root = tokio::fs::canonicalize(working_dir)
        .await
        .map_err(|error| format!("Could not resolve working directory: {error}"))?;
    let mut prepared = call.clone();
    let args = prepared
        .args
        .as_object_mut()
        .ok_or_else(|| "Tool arguments must be a JSON object".to_string())?;
    let mut resources = Vec::new();

    match call.tool.as_str() {
        "os.fs.read" | "os.fs.read_document" | "os.fs.hash" => {
            resolve_field(args, "path", &[], None, "read", &root, &mut resources).await?;
        }
        "os.fs.list" => {
            resolve_field(args, "path", &[], Some("."), "list", &root, &mut resources).await?;
        }
        "os.fs.glob" => {
            resolve_field(args, "cwd", &[], Some("."), "glob", &root, &mut resources).await?;
            let pattern = string_arg(args, "pattern", &[])?;
            let base = glob_static_base(&pattern);
            let cwd = Path::new(
                args.get("cwd")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Missing resolved glob cwd".to_string())?,
            );
            let resolved = resolve_candidate(cwd, &base).await?;
            resources.push(path_resource(&resolved, "glob"));
        }
        "os.fs.grep" => {
            resolve_field(args, "path", &[], Some("."), "grep", &root, &mut resources).await?;
        }
        "os.fs.diff" => {
            resolve_field(args, "pathA", &[], None, "read", &root, &mut resources).await?;
            resolve_field(args, "pathB", &[], None, "read", &root, &mut resources).await?;
        }
        "os.fs.write" => {
            resolve_field(args, "path", &[], None, "write", &root, &mut resources).await?;
        }
        "os.fs.edit" => {
            resolve_field(args, "path", &[], None, "edit", &root, &mut resources).await?;
        }
        "os.fs.trash" => {
            resolve_field(args, "path", &[], None, "trash", &root, &mut resources).await?;
        }
        "os.fs.patch" => {
            let patch = string_arg(args, "patch", &[])?;
            for path in patch_paths(&patch) {
                let resolved = resolve_candidate(&root, &path).await?;
                resources.push(path_resource(&resolved, "patch"));
            }
        }
        "os.fs.archive.list" | "os.fs.archive.read_entry" => {
            resolve_field(args, "path", &[], None, "read", &root, &mut resources).await?;
        }
        "os.fs.archive.extract" => {
            resolve_field(args, "path", &[], None, "read", &root, &mut resources).await?;
            resolve_field(
                args,
                "destination",
                &["dest"],
                None,
                "extract",
                &root,
                &mut resources,
            )
            .await?;
        }
        tool if tool.starts_with("os.git.") => {
            resolve_field(
                args,
                "cwd",
                &[],
                Some("."),
                "git_read",
                &root,
                &mut resources,
            )
            .await?;
            if args.contains_key("path") {
                let cwd = PathBuf::from(
                    args.get("cwd")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "Missing resolved git cwd".to_string())?,
                );
                resolve_field(args, "path", &[], None, "read", &cwd, &mut resources).await?;
            }
        }
        "os.shell.run" => {
            resolve_field(
                args,
                "cwd",
                &[],
                Some("."),
                "shell_cwd",
                &root,
                &mut resources,
            )
            .await?;
        }
        _ => {}
    }

    let escaped_root = resources
        .iter()
        .filter(|resource| resource.kind == "path")
        .any(|resource| !Path::new(&resource.value).starts_with(&root));
    Ok(PreparedPaths {
        call: prepared,
        resources,
        escaped_root,
    })
}

async fn resolve_field(
    args: &mut Map<String, Value>,
    key: &str,
    aliases: &[&str],
    default: Option<&str>,
    operation: &str,
    root: &Path,
    resources: &mut Vec<ApprovalResource>,
) -> Result<(), String> {
    let raw = args
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            aliases
                .iter()
                .find_map(|alias| args.get(*alias).and_then(Value::as_str).map(str::to_owned))
        })
        .or_else(|| default.map(str::to_owned))
        .ok_or_else(|| format!("Missing non-empty string argument `{key}`"))?;
    if raw.is_empty() {
        return Err(format!("Missing non-empty string argument `{key}`"));
    }
    let resolved = resolve_candidate(root, &raw).await?;
    args.insert(
        key.to_string(),
        Value::String(resolved.to_string_lossy().into_owned()),
    );
    for alias in aliases {
        args.remove(*alias);
    }
    resources.push(path_resource(&resolved, operation));
    Ok(())
}

fn string_arg(args: &Map<String, Value>, key: &str, aliases: &[&str]) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .or_else(|| {
            aliases
                .iter()
                .find_map(|alias| args.get(*alias).and_then(Value::as_str))
        })
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing non-empty string argument `{key}`"))
}

async fn resolve_candidate(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let expanded = expand_home(raw)?;
    let joined = if expanded.is_absolute() {
        expanded
    } else {
        root.join(expanded)
    };
    let normalized = lexical_normalize(&joined);
    if tokio::fs::symlink_metadata(&normalized).await.is_ok() {
        return tokio::fs::canonicalize(&normalized).await.map_err(|error| {
            format!("Could not resolve path '{}': {error}", normalized.display())
        });
    }

    let mut ancestor = normalized.as_path();
    let mut suffix = Vec::new();
    while tokio::fs::symlink_metadata(ancestor).await.is_err() {
        let name = ancestor.file_name().ok_or_else(|| {
            format!(
                "Could not find an existing ancestor for '{}'",
                normalized.display()
            )
        })?;
        suffix.push(name.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            format!(
                "Could not find an existing ancestor for '{}'",
                normalized.display()
            )
        })?;
    }
    let mut resolved = tokio::fs::canonicalize(ancestor)
        .await
        .map_err(|error| format!("Could not resolve path '{}': {error}", ancestor.display()))?;
    for part in suffix.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

pub(super) fn expand_home(raw: &str) -> Result<PathBuf, String> {
    if raw == "~" {
        return dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string());
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return dirs::home_dir()
            .map(|home| home.join(rest))
            .ok_or_else(|| "Could not resolve home directory".to_string());
    }
    Ok(PathBuf::from(raw))
}

pub(super) fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn glob_static_base(pattern: &str) -> String {
    let mut base = PathBuf::new();
    for component in Path::new(pattern).components() {
        let text = component.as_os_str().to_string_lossy();
        if text.contains(['*', '?', '[', '{']) {
            break;
        }
        base.push(component.as_os_str());
    }
    if base.as_os_str().is_empty() {
        ".".into()
    } else {
        base.to_string_lossy().into_owned()
    }
}

fn patch_paths(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|line| {
            line.strip_prefix("--- ")
                .or_else(|| line.strip_prefix("+++ "))
        })
        .filter_map(|line| line.split_whitespace().next())
        .filter(|path| *path != "/dev/null")
        .map(str::to_owned)
        .collect()
}

fn path_resource(path: &Path, operation: &str) -> ApprovalResource {
    ApprovalResource {
        kind: "path".into(),
        value: path.to_string_lossy().into_owned(),
        operation: operation.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("atomic-chat-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn resolves_relative_and_missing_write_targets_inside_root() {
        let root = test_dir();
        let call = ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({"path": "nested/new.txt", "content": "x"}),
        };
        let prepared = prepare_call_paths(&call, &root).await.unwrap();
        let canonical_root = tokio::fs::canonicalize(&root).await.unwrap();
        assert!(!prepared.escaped_root);
        assert_eq!(
            prepared.call.args["path"],
            canonical_root
                .join("nested/new.txt")
                .to_string_lossy()
                .as_ref()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn detects_parent_escape() {
        let parent = test_dir();
        let root = parent.join("root");
        tokio::fs::create_dir(&root).await.unwrap();
        let call = ToolCallPayload {
            tool: "os.fs.read".into(),
            args: serde_json::json!({"path": "../outside.txt"}),
        };
        let prepared = prepare_call_paths(&call, &root).await.unwrap();
        assert!(prepared.escaped_root);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn detects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let parent = test_dir();
        let root = parent.join("root");
        let outside = parent.join("outside");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&outside).await.unwrap();
        symlink(&outside, root.join("link")).unwrap();
        let call = ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({"path": "link/new.txt", "content": "x"}),
        };
        let prepared = prepare_call_paths(&call, &root).await.unwrap();
        let canonical_outside = tokio::fs::canonicalize(&outside).await.unwrap();
        assert!(prepared.escaped_root);
        assert_eq!(
            prepared.call.args["path"],
            canonical_outside.join("new.txt").to_string_lossy().as_ref()
        );
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn canonicalizes_legacy_archive_destination_alias() {
        let root = test_dir();
        let archive = root.join("archive.zip");
        tokio::fs::write(&archive, []).await.unwrap();
        let call = ToolCallPayload {
            tool: "os.fs.archive.extract".into(),
            args: serde_json::json!({"path": "archive.zip", "dest": "out"}),
        };
        let prepared = prepare_call_paths(&call, &root).await.unwrap();
        let canonical_root = tokio::fs::canonicalize(&root).await.unwrap();
        assert!(prepared.call.args.get("dest").is_none());
        assert_eq!(
            prepared.call.args["destination"],
            canonical_root.join("out").to_string_lossy().as_ref()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
