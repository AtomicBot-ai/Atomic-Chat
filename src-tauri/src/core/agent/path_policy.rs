use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use super::types::{ApprovalResource, FolderAccessRequest, ToolCallPayload};

const ATTACHMENT_URI_PREFIX: &str = "attachment://";
pub(super) const MAX_TRASH_PATHS: usize = 500;

#[derive(Debug)]
pub struct PreparedPaths {
    pub call: ToolCallPayload,
    pub resources: Vec<ApprovalResource>,
    pub escaped_root: bool,
    pub folder_access: Option<FolderAccessRequest>,
}

#[derive(Clone, Debug)]
pub struct EditableRoots {
    roots: Arc<RwLock<Vec<PathBuf>>>,
}

impl EditableRoots {
    pub async fn new(primary_root: &Path, external_roots: &[PathBuf]) -> Result<Self, String> {
        let primary = canonical_directory(primary_root).await?;
        let mut roots = vec![primary];
        for root in external_roots {
            let canonical = canonical_directory(root).await?;
            if !roots.contains(&canonical) {
                roots.push(canonical);
            }
        }
        Ok(Self {
            roots: Arc::new(RwLock::new(roots)),
        })
    }

    pub async fn add(&self, root: &Path) -> Result<PathBuf, String> {
        let canonical = canonical_directory(root).await?;
        let mut roots = self.roots.write().await;
        if !roots.contains(&canonical) {
            roots.push(canonical.clone());
        }
        Ok(canonical)
    }

    pub async fn snapshot(&self) -> Vec<PathBuf> {
        self.roots.read().await.clone()
    }

    #[cfg(test)]
    pub(crate) fn for_test(primary_root: &Path) -> Self {
        let primary = std::fs::canonicalize(primary_root).expect("canonical test root");
        Self {
            roots: Arc::new(RwLock::new(vec![primary])),
        }
    }
}

pub async fn prepare_call_paths(
    call: &ToolCallPayload,
    primary_root: &Path,
    editable_roots: &EditableRoots,
    trusted_read_roots: &[PathBuf],
) -> Result<PreparedPaths, String> {
    let root = canonical_directory(primary_root).await?;
    let mut prepared = call.clone();
    let args = prepared
        .args
        .as_object_mut()
        .ok_or_else(|| "Tool arguments must be a JSON object".to_string())?;
    let mut resources = Vec::new();

    expand_attachment_aliases(&call.tool, args, trusted_read_roots).await?;
    validate_destructive_args(&call.tool, args)?;

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
        "os.fs.mkdir" => {
            resolve_field(
                args,
                "path",
                &[],
                None,
                "create-directory",
                &root,
                &mut resources,
            )
            .await?;
        }
        "os.fs.edit" => {
            resolve_field(args, "path", &[], None, "edit", &root, &mut resources).await?;
        }
        "os.fs.trash" => {
            normalize_trash_paths(args)?;
            resolve_array_field(args, "paths", "trash", &root, &mut resources).await?;
            reject_protected_trash_targets(args, &root).await?;
        }
        "os.fs.patch" => {
            let patch = string_arg(args, "patch", &[])?;
            let targets = patch_paths(&patch);
            if targets.is_empty() {
                return Err("Patch must contain at least one file target".into());
            }
            let mut resolved_targets = Vec::new();
            for path in targets {
                validate_patch_target(&path)?;
                let resolved = resolve_candidate(&root, &path).await?;
                if !resolved_targets.contains(&resolved) {
                    resources.push(path_resource(&resolved, "patch"));
                    resolved_targets.push(resolved);
                }
            }
            args.insert(
                "patch_paths".into(),
                Value::Array(
                    resolved_targets
                        .into_iter()
                        .map(|path| Value::String(path.to_string_lossy().into_owned()))
                        .collect(),
                ),
            );
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
        "vision.describe" => {
            resolve_array_field(args, "paths", "read", &root, &mut resources).await?;
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

    let editable_roots = editable_roots.snapshot().await;
    let escaped_resource = resources
        .iter()
        .filter(|resource| resource.kind == "path")
        .find(|resource| {
            let path = Path::new(&resource.value);
            if editable_roots
                .iter()
                .any(|editable_root| path.starts_with(editable_root))
            {
                return false;
            }
            !is_read_operation(&resource.operation)
                || !trusted_read_roots
                    .iter()
                    .any(|trusted_root| path.starts_with(trusted_root))
        })
        .cloned();
    let folder_access = match escaped_resource {
        Some(ref resource) if is_path_aware_filesystem_tool(&call.tool) => {
            let path = Path::new(&resource.value);
            let requested_root = nearest_existing_directory(path).await?;
            Some(FolderAccessRequest {
                tool: call.tool.clone(),
                path: requested_root.to_string_lossy().into_owned(),
                display_name: requested_root
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| requested_root.display().to_string()),
                root_id: root_id_for_path(&requested_root),
                reason: format!(
                    "{} needs access to a folder outside the connected roots",
                    call.tool
                ),
            })
        }
        _ => None,
    };
    Ok(PreparedPaths {
        call: prepared,
        resources,
        escaped_root: escaped_resource.is_some(),
        folder_access,
    })
}

pub(super) async fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| format!("Could not resolve directory '{}': {error}", path.display()))?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|error| format!("Could not inspect directory '{}': {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }
    Ok(canonical)
}

async fn nearest_existing_directory(path: &Path) -> Result<PathBuf, String> {
    let mut candidate = path;
    loop {
        match tokio::fs::metadata(candidate).await {
            Ok(metadata) if metadata.is_dir() => {
                return tokio::fs::canonicalize(candidate).await.map_err(|error| {
                    format!(
                        "Could not resolve folder '{}': {error}",
                        candidate.display()
                    )
                });
            }
            Ok(_) => {
                candidate = candidate.parent().ok_or_else(|| {
                    format!(
                        "Could not find a containing folder for '{}'",
                        path.display()
                    )
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                candidate = candidate.parent().ok_or_else(|| {
                    format!("Could not find an existing folder for '{}'", path.display())
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Could not inspect folder candidate '{}': {error}",
                    candidate.display()
                ));
            }
        }
    }
}

fn is_path_aware_filesystem_tool(tool: &str) -> bool {
    tool.starts_with("os.fs.") || tool.starts_with("os.git.") || tool == "vision.describe"
}

pub fn root_id_for_path(path: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    format!("root-{:x}", digest.finalize())
}

fn validate_destructive_args(tool: &str, args: &Map<String, Value>) -> Result<(), String> {
    match tool {
        "os.fs.write" => {
            string_arg(args, "path", &[])?;
            args.get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| "Missing string argument `content`".to_string())?;
            if let Some(mode) = args.get("mode") {
                match mode.as_str() {
                    Some("replace" | "append") => {}
                    _ => return Err("`mode` must be \"replace\" or \"append\"".into()),
                }
            }
        }
        "os.fs.mkdir" => {
            string_arg(args, "path", &[])?;
            if args
                .get("recursive")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err("`recursive` must be a boolean".into());
            }
        }
        "os.fs.edit" => {
            string_arg(args, "path", &[])?;
            let old = string_arg(args, "oldString", &[])?;
            let new = args
                .get("newString")
                .and_then(Value::as_str)
                .ok_or_else(|| "Missing string argument `newString`".to_string())?;
            if old == new {
                return Err("`newString` must differ from `oldString`".into());
            }
            if args
                .get("replaceAll")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err("`replaceAll` must be a boolean".into());
            }
        }
        "os.fs.trash" => {
            if !args.contains_key("paths") {
                string_arg(args, "path", &[])?;
            }
        }
        "os.fs.patch" => {
            string_arg(args, "patch", &[])?;
            if args.get("apply").is_some_and(|value| !value.is_boolean()) {
                return Err("`apply` must be a boolean".into());
            }
        }
        "os.fs.archive.extract" => {
            string_arg(args, "path", &[])?;
            string_arg(args, "destination", &["dest"])?;
            if args
                .get("overwrite")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err("`overwrite` must be a boolean".into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_trash_paths(args: &mut Map<String, Value>) -> Result<(), String> {
    if !args.contains_key("paths") {
        let path = args
            .remove("path")
            .ok_or_else(|| "Missing non-empty array argument `paths`".to_string())?;
        args.insert("paths".into(), Value::Array(vec![path]));
    } else {
        args.remove("path");
    }
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| "`paths` must be a non-empty array of strings".to_string())?;
    if paths.is_empty() {
        return Err("`paths` must be a non-empty array of strings".into());
    }
    if paths.len() > MAX_TRASH_PATHS {
        return Err(format!(
            "`paths` accepts at most {MAX_TRASH_PATHS} entries (got {})",
            paths.len()
        ));
    }
    Ok(())
}

async fn reject_protected_trash_targets(
    args: &Map<String, Value>,
    working_root: &Path,
) -> Result<(), String> {
    let mut protected = vec![working_root.to_path_buf()];
    for candidate in [
        dirs::home_dir(),
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::download_dir(),
    ]
    .into_iter()
    .flatten()
    {
        if let Ok(canonical) = tokio::fs::canonicalize(candidate).await {
            protected.push(canonical);
        }
    }
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing resolved trash paths".to_string())?;
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        let raw = path
            .as_str()
            .ok_or_else(|| "`paths` must contain only non-empty strings".to_string())?;
        let target = PathBuf::from(raw);
        if !seen.insert(target.clone()) {
            return Err(format!("Duplicate trash target: {}", target.display()));
        }
        if target.parent().is_none() || protected.iter().any(|root| root == &target) {
            return Err(format!(
                "Refusing to trash protected root '{}'; select concrete child paths instead",
                target.display()
            ));
        }
    }
    Ok(())
}

async fn expand_attachment_aliases(
    tool: &str,
    args: &mut Map<String, Value>,
    trusted_read_roots: &[PathBuf],
) -> Result<(), String> {
    match tool {
        "os.fs.read"
        | "os.fs.read_document"
        | "os.fs.hash"
        | "os.fs.archive.list"
        | "os.fs.archive.read_entry"
        | "os.fs.archive.extract" => {
            expand_attachment_alias_field(args, "path", trusted_read_roots).await
        }
        "vision.describe" => {
            let Some(paths) = args.get_mut("paths").and_then(Value::as_array_mut) else {
                return Ok(());
            };
            for path in paths {
                let Some(raw) = path.as_str() else {
                    continue;
                };
                if raw.starts_with(ATTACHMENT_URI_PREFIX) {
                    let resolved = resolve_attachment_alias(raw, trusted_read_roots).await?;
                    *path = Value::String(resolved.to_string_lossy().into_owned());
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn expand_attachment_alias_field(
    args: &mut Map<String, Value>,
    key: &str,
    trusted_read_roots: &[PathBuf],
) -> Result<(), String> {
    let Some(raw) = args.get(key).and_then(Value::as_str) else {
        return Ok(());
    };
    if !raw.starts_with(ATTACHMENT_URI_PREFIX) {
        return Ok(());
    }
    let resolved = resolve_attachment_alias(raw, trusted_read_roots).await?;
    args.insert(
        key.to_string(),
        Value::String(resolved.to_string_lossy().into_owned()),
    );
    Ok(())
}

async fn resolve_attachment_alias(
    raw: &str,
    trusted_read_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let name = raw
        .strip_prefix(ATTACHMENT_URI_PREFIX)
        .ok_or_else(|| "Invalid attachment reference".to_string())?;
    let path = Path::new(name);
    let mut components = path.components();
    if name.is_empty()
        || name.contains('\\')
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(format!(
            "Attachment reference must contain one safe file name: {raw}"
        ));
    }

    let mut resolved_match = None;
    for trusted_root in trusted_read_roots {
        let canonical_root = tokio::fs::canonicalize(trusted_root)
            .await
            .map_err(|error| format!("Could not resolve attachment root: {error}"))?;
        let candidate = canonical_root.join(name);
        let resolved = match tokio::fs::canonicalize(&candidate).await {
            Ok(resolved) => resolved,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Could not resolve attachment reference {raw}: {error}"
                ));
            }
        };
        if resolved.parent() != Some(canonical_root.as_path()) {
            return Err(format!(
                "Attachment reference escapes its trusted root: {raw}"
            ));
        }
        if resolved_match.replace(resolved).is_some() {
            return Err(format!("Attachment reference is ambiguous: {raw}"));
        }
    }

    resolved_match.ok_or_else(|| format!("Attachment reference was not found: {raw}"))
}

async fn resolve_array_field(
    args: &mut Map<String, Value>,
    key: &str,
    operation: &str,
    root: &Path,
    resources: &mut Vec<ApprovalResource>,
) -> Result<(), String> {
    let values = args
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Missing array argument `{key}`"))?;
    if values.is_empty() {
        return Err(format!("Array argument `{key}` must not be empty"));
    }
    let mut resolved_values = Vec::with_capacity(values.len());
    for value in values {
        let raw = value
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Array argument `{key}` must contain non-empty strings"))?;
        let resolved = resolve_candidate(root, raw).await?;
        resources.push(path_resource(&resolved, operation));
        resolved_values.push(Value::String(resolved.to_string_lossy().into_owned()));
    }
    args.insert(key.to_string(), Value::Array(resolved_values));
    Ok(())
}

fn is_read_operation(operation: &str) -> bool {
    matches!(operation, "read" | "list" | "glob" | "grep" | "git_read")
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

#[cfg(windows)]
fn path_buf_from_input(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix(r"\?\") {
        return PathBuf::from(format!(r"\\?\{rest}"));
    }
    PathBuf::from(raw)
}

#[cfg(not(windows))]
fn path_buf_from_input(raw: &str) -> PathBuf {
    PathBuf::from(raw)
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
    Ok(path_buf_from_input(raw))
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

fn validate_patch_target(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "Patch target must be relative and must not traverse parents: {}",
            path.display()
        ));
    }
    Ok(())
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

    async fn prepare_call_paths(
        call: &ToolCallPayload,
        primary_root: &Path,
        trusted_read_roots: &[PathBuf],
    ) -> Result<PreparedPaths, String> {
        let editable_roots = EditableRoots::new(primary_root, &[]).await?;
        super::prepare_call_paths(call, primary_root, &editable_roots, trusted_read_roots).await
    }

    fn test_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("atomic-chat-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[tokio::test]
    async fn resolves_relative_and_missing_write_targets_inside_root() {
        let root = test_dir();
        let call = ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({"path": "nested/new.txt", "content": "x"}),
        };
        let prepared = prepare_call_paths(&call, &root, &[]).await.unwrap();
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
    async fn trusts_canonical_external_editable_roots_and_deduplicates_them() {
        let parent = test_dir();
        let primary = parent.join("primary");
        let external = parent.join("external");
        tokio::fs::create_dir(&primary).await.unwrap();
        tokio::fs::create_dir(&external).await.unwrap();
        let roots = EditableRoots::new(&primary, &[external.clone(), external.clone()])
            .await
            .unwrap();
        assert_eq!(roots.snapshot().await.len(), 2);

        let call = ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({
                "path": external.join("new.txt"),
                "content": "x"
            }),
        };
        let prepared = super::prepare_call_paths(&call, &primary, &roots, &[])
            .await
            .unwrap();
        assert!(!prepared.escaped_root);
        assert!(prepared.folder_access.is_none());
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn requests_nearest_existing_parent_for_new_external_file() {
        let parent = test_dir();
        let primary = parent.join("primary");
        let desktop = parent.join("Desktop");
        tokio::fs::create_dir(&primary).await.unwrap();
        tokio::fs::create_dir(&desktop).await.unwrap();
        let roots = EditableRoots::new(&primary, &[]).await.unwrap();
        let call = ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({
                "path": desktop.join("nested/new.txt"),
                "content": "x"
            }),
        };

        let prepared = super::prepare_call_paths(&call, &primary, &roots, &[])
            .await
            .unwrap();
        let request = prepared.folder_access.unwrap();
        assert_eq!(
            PathBuf::from(request.path),
            tokio::fs::canonicalize(&desktop).await.unwrap()
        );
        assert!(prepared.escaped_root);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn resolves_windows_absolute_and_verbatim_write_targets_outside_root() {
        let parent = test_dir();
        let root = parent.join("workspace");
        let outside = parent.join("outside");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&outside).await.unwrap();
        let canonical_outside = tokio::fs::canonicalize(&outside).await.unwrap();
        let verbatim = canonical_outside.to_string_lossy().into_owned();
        let plain = verbatim
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| verbatim.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or_else(|| verbatim.clone());
        let malformed_verbatim = verbatim
            .strip_prefix(r"\\?\")
            .map(|rest| format!(r"\?\{rest}"))
            .expect("Windows canonical paths use the verbatim prefix");

        for (index, base) in [plain, verbatim, malformed_verbatim]
            .into_iter()
            .enumerate()
        {
            let file_name = format!("case-{index}.txt");
            let call = ToolCallPayload {
                tool: "os.fs.write".into(),
                args: serde_json::json!({
                    "path": PathBuf::from(base).join(&file_name),
                    "content": "x"
                }),
            };
            let prepared = prepare_call_paths(&call, &root, &[]).await.unwrap();

            assert!(prepared.escaped_root);
            assert_eq!(
                prepared.call.args["path"],
                canonical_outside
                    .join(&file_name)
                    .to_string_lossy()
                    .as_ref()
            );
            let resolved = PathBuf::from(prepared.call.args["path"].as_str().unwrap());
            tokio::fs::write(&resolved, b"x").await.unwrap();
            assert_eq!(
                tokio::fs::read(outside.join(&file_name)).await.unwrap(),
                b"x"
            );
        }

        std::fs::remove_dir_all(parent).unwrap();
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
        let prepared = prepare_call_paths(&call, &root, &[]).await.unwrap();
        assert!(prepared.escaped_root);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn trusts_only_read_operations_under_attachment_roots() {
        let parent = test_dir();
        let root = parent.join("workspace");
        let attachments = parent.join("attachments");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&attachments).await.unwrap();
        let attachment = attachments.join("document.txt");
        tokio::fs::write(&attachment, "fixture").await.unwrap();
        let trusted_root = tokio::fs::canonicalize(&attachments).await.unwrap();

        let read = ToolCallPayload {
            tool: "os.fs.read_document".into(),
            args: serde_json::json!({"path": attachment}),
        };
        let prepared = prepare_call_paths(&read, &root, std::slice::from_ref(&trusted_root))
            .await
            .unwrap();
        assert!(!prepared.escaped_root);

        let write = ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({
                "path": trusted_root.join("new.txt"),
                "content": "blocked without approval"
            }),
        };
        let prepared = prepare_call_paths(&write, &root, std::slice::from_ref(&trusted_root))
            .await
            .unwrap();
        assert!(prepared.escaped_root);

        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn resolves_attachment_uri_inside_the_current_trusted_root() {
        let parent = test_dir();
        let root = parent.join("workspace");
        let attachments = parent.join("attachments");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&attachments).await.unwrap();
        let attachment = attachments.join("01.pdf");
        tokio::fs::write(&attachment, "fixture").await.unwrap();
        let trusted_root = tokio::fs::canonicalize(&attachments).await.unwrap();
        let canonical_attachment = tokio::fs::canonicalize(&attachment).await.unwrap();
        let call = ToolCallPayload {
            tool: "os.fs.read_document".into(),
            args: serde_json::json!({"path": "attachment://01.pdf"}),
        };

        let prepared = prepare_call_paths(&call, &root, std::slice::from_ref(&trusted_root))
            .await
            .unwrap();

        assert!(!prepared.escaped_root);
        assert_eq!(
            prepared.call.args["path"],
            canonical_attachment.to_string_lossy().as_ref()
        );
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn rejects_missing_and_traversing_attachment_uris() {
        let parent = test_dir();
        let root = parent.join("workspace");
        let attachments = parent.join("attachments");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&attachments).await.unwrap();
        let trusted_root = tokio::fs::canonicalize(&attachments).await.unwrap();

        for path in [
            "attachment://../secret.txt",
            "attachment://nested/secret.txt",
        ] {
            let call = ToolCallPayload {
                tool: "os.fs.read".into(),
                args: serde_json::json!({"path": path}),
            };
            let error = prepare_call_paths(&call, &root, std::slice::from_ref(&trusted_root))
                .await
                .unwrap_err();
            assert!(error.contains("one safe file name"));
        }

        let missing = ToolCallPayload {
            tool: "os.fs.read".into(),
            args: serde_json::json!({"path": "attachment://01.txt"}),
        };
        let error = prepare_call_paths(&missing, &root, &[]).await.unwrap_err();
        assert!(error.contains("was not found"));

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
        let prepared = prepare_call_paths(&call, &root, &[]).await.unwrap();
        let canonical_outside = tokio::fs::canonicalize(&outside).await.unwrap();
        assert!(prepared.escaped_root);
        assert_eq!(
            prepared.call.args["path"],
            canonical_outside.join("new.txt").to_string_lossy().as_ref()
        );
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn detects_junction_escape_for_existing_and_missing_targets() {
        let parent = test_dir();
        let root = parent.join("root");
        let outside = parent.join("outside");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&outside).await.unwrap();
        tokio::fs::write(outside.join("existing.txt"), "outside")
            .await
            .unwrap();
        let junction = root.join("link");
        create_junction(&junction, &outside);
        let canonical_outside = tokio::fs::canonicalize(&outside).await.unwrap();

        for (path, expected) in [
            ("link/existing.txt", canonical_outside.join("existing.txt")),
            ("link/missing.txt", canonical_outside.join("missing.txt")),
        ] {
            let call = ToolCallPayload {
                tool: "os.fs.write".into(),
                args: serde_json::json!({"path": path, "content": "x"}),
            };
            let prepared = prepare_call_paths(&call, &root, &[]).await.unwrap();
            assert!(prepared.escaped_root, "{path} must escape through junction");
            assert_eq!(
                prepared.call.args["path"],
                expected.to_string_lossy().as_ref()
            );
        }

        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn detects_directory_symlink_escape_when_creation_is_allowed() {
        use std::os::windows::fs::symlink_dir;

        let parent = test_dir();
        let root = parent.join("root");
        let outside = parent.join("outside");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&outside).await.unwrap();
        let link = root.join("link");
        if let Err(error) = symlink_dir(&outside, &link) {
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314)
            {
                std::fs::remove_dir_all(parent).unwrap();
                return;
            }
            panic!("could not create directory symlink fixture: {error}");
        }

        let call = ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({"path": "link/new.txt", "content": "x"}),
        };
        let prepared = prepare_call_paths(&call, &root, &[]).await.unwrap();
        assert!(prepared.escaped_root);
        assert_eq!(
            prepared.call.args["path"],
            tokio::fs::canonicalize(&outside)
                .await
                .unwrap()
                .join("new.txt")
                .to_string_lossy()
                .as_ref()
        );

        std::fs::remove_dir(&link).unwrap();
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
        let prepared = prepare_call_paths(&call, &root, &[]).await.unwrap();
        let canonical_root = tokio::fs::canonicalize(&root).await.unwrap();
        assert!(prepared.call.args.get("dest").is_none());
        assert_eq!(
            prepared.call.args["destination"],
            canonical_root.join("out").to_string_lossy().as_ref()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn trash_rejects_workspace_root_but_allows_concrete_children() {
        let root = test_dir();
        let child = root.join("image.png");
        tokio::fs::write(&child, b"image").await.unwrap();

        let root_call = ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({"paths": [root.to_string_lossy()]}),
        };
        let error = prepare_call_paths(&root_call, &root, &[])
            .await
            .unwrap_err();
        assert!(error.contains("protected root"));

        let child_call = ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({"paths": ["image.png"]}),
        };
        let prepared = prepare_call_paths(&child_call, &root, &[]).await.unwrap();
        let canonical_child = tokio::fs::canonicalize(&child).await.unwrap();
        assert_eq!(
            prepared.call.args["paths"],
            serde_json::json!([canonical_child])
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn trash_normalizes_legacy_path_and_rejects_invalid_batches() {
        let root = test_dir();
        let child = root.join("one.txt");
        tokio::fs::write(&child, b"one").await.unwrap();

        let legacy = ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({"path": "one.txt"}),
        };
        let prepared = prepare_call_paths(&legacy, &root, &[]).await.unwrap();
        assert!(prepared.call.args.get("path").is_none());
        assert_eq!(prepared.call.args["paths"].as_array().unwrap().len(), 1);

        for args in [
            serde_json::json!({"paths": []}),
            serde_json::json!({"paths": [""]}),
            serde_json::json!({"paths": [1]}),
            serde_json::json!({"paths": ["one.txt", "./one.txt"]}),
        ] {
            let call = ToolCallPayload {
                tool: "os.fs.trash".into(),
                args,
            };
            assert!(prepare_call_paths(&call, &root, &[]).await.is_err());
        }

        let oversized = ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({"paths": vec!["one.txt"; MAX_TRASH_PATHS + 1]}),
        };
        assert!(prepare_call_paths(&oversized, &root, &[]).await.is_err());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn patch_rejects_absolute_and_parent_traversal_targets() {
        let root = test_dir();
        for patch in [
            "--- /tmp/file.txt\n+++ /tmp/file.txt\n@@ -1 +1 @@\n-a\n+b\n",
            "--- ../file.txt\n+++ ../file.txt\n@@ -1 +1 @@\n-a\n+b\n",
        ] {
            let call = ToolCallPayload {
                tool: "os.fs.patch".into(),
                args: serde_json::json!({"patch": patch, "apply": true}),
            };
            let error = prepare_call_paths(&call, &root, &[]).await.unwrap_err();
            assert!(error.contains("relative"));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
