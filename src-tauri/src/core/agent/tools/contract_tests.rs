use std::io::Write;
use std::process::Command;

use tokio_util::sync::CancellationToken;

use super::super::path_policy::EditableRoots;
use super::super::skills::{loaded::LoadedSkills, SkillRegistry};
use super::tool_view::LoadedTools;
use super::{execute, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::test_support::{
    RecordingApproval, RecordingDesktop, RecordingFolderAccess, TestWorkspace,
};
use crate::core::agent::types::{ToolCallPayload, ToolOutcome, ToolStatus};

struct ToolFixture {
    workspace: TestWorkspace,
    editable_roots: EditableRoots,
    approval: RecordingApproval,
    folder_access: RecordingFolderAccess,
    desktop: RecordingDesktop,
    cancellation: CancellationToken,
    loaded_tools: LoadedTools,
    loaded_skills: LoadedSkills,
    skill_registry: SkillRegistry,
}

impl ToolFixture {
    fn allowed() -> Self {
        let workspace = TestWorkspace::new();
        let editable_roots = EditableRoots::for_test(workspace.path());
        let skill_registry = workspace.skill_registry();
        Self {
            workspace,
            editable_roots,
            approval: RecordingApproval::allow(),
            folder_access: RecordingFolderAccess::deny(),
            desktop: RecordingDesktop::default(),
            cancellation: CancellationToken::new(),
            loaded_tools: LoadedTools::default(),
            loaded_skills: LoadedSkills::default(),
            skill_registry,
        }
    }

    fn denied() -> Self {
        let workspace = TestWorkspace::new();
        let editable_roots = EditableRoots::for_test(workspace.path());
        let skill_registry = workspace.skill_registry();
        Self {
            workspace,
            editable_roots,
            approval: RecordingApproval::deny(),
            folder_access: RecordingFolderAccess::deny(),
            desktop: RecordingDesktop::default(),
            cancellation: CancellationToken::new(),
            loaded_tools: LoadedTools::default(),
            loaded_skills: LoadedSkills::default(),
            skill_registry,
        }
    }

    async fn call(&self, tool: &str, args: serde_json::Value) -> ToolOutcome {
        execute(
            &ToolCallPayload {
                tool: tool.into(),
                args,
            },
            &ToolContext {
                working_dir: self.workspace.path(),
                editable_roots: &self.editable_roots,
                trusted_read_roots: &[],
                client: None,
                approval: &self.approval,
                folder_access: &self.folder_access,
                cancellation: &self.cancellation,
                loaded_tools: &self.loaded_tools,
                loaded_skills: &self.loaded_skills,
                skill_registry: &self.skill_registry,
                bundled_script_runtime: None,
                desktop: &self.desktop,
            },
        )
        .await
    }
}

#[tokio::test]
async fn filesystem_tools_apply_real_operations_in_an_isolated_workspace() {
    let fixture = ToolFixture::allowed();
    fixture
        .workspace
        .write("source.txt", "alpha\nneedle beta\n");
    fixture.workspace.write("other.txt", "alpha\ngamma\n");

    let read = fixture
        .call(
            "os.fs.read",
            serde_json::json!({"path": "source.txt", "offset": 6, "limit": 11}),
        )
        .await;
    assert_eq!(read.status, ToolStatus::Ok);
    assert_eq!(read.summary, "needle beta");

    let write = fixture
        .call(
            "os.fs.write",
            serde_json::json!({"path": "nested/written.txt", "content": "before\n"}),
        )
        .await;
    assert_eq!(write.status, ToolStatus::Ok);

    let edit = fixture
        .call(
            "os.fs.edit",
            serde_json::json!({
                "path": "nested/written.txt",
                "oldString": "before",
                "newString": "after"
            }),
        )
        .await;
    assert_eq!(edit.status, ToolStatus::Ok);
    assert_eq!(fixture.workspace.read("nested/written.txt"), b"after\n");

    let list = fixture
        .call("os.fs.list", serde_json::json!({"path": "."}))
        .await;
    assert!(list.summary.contains("file\tsource.txt"));
    assert!(list.summary.contains("dir\tnested"));

    let glob = fixture
        .call("os.fs.glob", serde_json::json!({"pattern": "**/*.txt"}))
        .await;
    assert!(
        glob.summary.contains("nested/written.txt"),
        "unexpected glob summary: {:?}",
        glob.summary
    );
    assert!(glob.summary.contains("source.txt"));

    let grep = fixture
        .call(
            "os.fs.grep",
            serde_json::json!({"pattern": "needle", "path": "."}),
        )
        .await;
    assert_eq!(grep.status, ToolStatus::Ok);
    assert!(grep.summary.contains("source.txt:2:needle beta"));

    let hash = fixture
        .call(
            "os.fs.hash",
            serde_json::json!({"path": "source.txt", "algorithm": "sha256"}),
        )
        .await;
    assert_eq!(
        hash.summary,
        "a7047c9b4ef30c0eb584dc3bb9f4a3b7033b0ddc0f5b3a13ed03f47d5152d880"
    );

    let diff = fixture
        .call(
            "os.fs.diff",
            serde_json::json!({"pathA": "source.txt", "pathB": "other.txt"}),
        )
        .await;
    assert_eq!(diff.status, ToolStatus::Ok);
    assert!(diff.summary.contains("-needle beta"));
    assert!(diff.summary.contains("+gamma"));

    fixture.workspace.write("patch.txt", "before\n");
    let patch = "--- patch.txt\n+++ patch.txt\n@@ -1 +1 @@\n-before\n+after\n";
    let dry_run = fixture
        .call(
            "os.fs.patch",
            serde_json::json!({"patch": patch, "apply": false}),
        )
        .await;
    assert_eq!(dry_run.status, ToolStatus::Ok);
    assert_eq!(fixture.workspace.read("patch.txt"), b"before\n");
    let applied = fixture
        .call(
            "os.fs.patch",
            serde_json::json!({"patch": patch, "apply": true}),
        )
        .await;
    assert_eq!(applied.status, ToolStatus::Ok);
    assert_eq!(fixture.workspace.read("patch.txt"), b"after\n");
}

#[tokio::test]
async fn filesystem_grep_is_recursive_bounded_and_skips_non_text_files() {
    let fixture = ToolFixture::allowed();
    fixture
        .workspace
        .write("nested/match.txt", "first\nneedle\n");
    fixture
        .workspace
        .write("nested/binary.bin", b"needle\0hidden");
    fixture
        .workspace
        .write("nested/non-utf8.txt", b"needle\xffhidden");
    fixture
        .workspace
        .write("large.txt", format!("needle {}\n", "x".repeat(20_000)));

    let grep = fixture
        .call(
            "os.fs.grep",
            serde_json::json!({"pattern": "needle", "path": "nested"}),
        )
        .await;
    assert_eq!(grep.status, ToolStatus::Ok);
    assert!(
        grep.summary.contains("nested/match.txt:2:needle"),
        "unexpected grep summary: {:?}",
        grep.summary
    );
    assert!(!grep.summary.contains("binary.bin"));
    assert!(!grep.summary.contains("non-utf8.txt"));

    let no_matches = fixture
        .call(
            "os.fs.grep",
            serde_json::json!({"pattern": "absent", "path": "nested"}),
        )
        .await;
    assert_eq!(no_matches.summary, "No matches");

    let direct_binary = fixture
        .call(
            "os.fs.grep",
            serde_json::json!({"pattern": "needle", "path": "nested/binary.bin"}),
        )
        .await;
    assert_eq!(direct_binary.status, ToolStatus::Error);
    assert!(direct_binary
        .summary
        .contains("binary files are not supported"));

    let bounded = fixture
        .call(
            "os.fs.grep",
            serde_json::json!({"pattern": "needle", "path": "large.txt"}),
        )
        .await;
    assert!(bounded.summary.ends_with("[truncated]"));
    assert!(bounded.summary.chars().count() <= MAX_TOOL_OUTPUT_CHARS + 12);
}

#[tokio::test]
async fn filesystem_diff_is_unified_and_rejects_non_text_files() {
    let fixture = ToolFixture::allowed();
    fixture.workspace.write("left.txt", "alpha\nbefore\n");
    fixture.workspace.write("right.txt", "alpha\nafter\n");

    let diff = fixture
        .call(
            "os.fs.diff",
            serde_json::json!({"pathA": "left.txt", "pathB": "right.txt"}),
        )
        .await;
    assert_eq!(diff.status, ToolStatus::Ok);
    assert!(
        diff.summary.starts_with("--- left.txt\n+++ right.txt\n@@"),
        "unexpected diff summary: {:?}",
        diff.summary
    );
    assert!(diff.summary.contains("-before"));
    assert!(diff.summary.contains("+after"));

    fixture.workspace.write("binary.bin", b"alpha\0beta");
    let binary = fixture
        .call(
            "os.fs.diff",
            serde_json::json!({"pathA": "left.txt", "pathB": "binary.bin"}),
        )
        .await;
    assert_eq!(binary.status, ToolStatus::Error);
    assert!(binary.summary.contains("binary files are not supported"));
}

#[tokio::test]
async fn filesystem_patch_defaults_to_validation_and_prevalidates_every_file() {
    let fixture = ToolFixture::allowed();
    fixture.workspace.write("one.txt", "one\n");
    fixture.workspace.write("two.txt", "two\n");
    let valid = "--- one.txt\n+++ one.txt\n@@ -1 +1 @@\n-one\n+ONE\n";
    let invalid = "--- two.txt\n+++ two.txt\n@@ -1 +1 @@\n-missing\n+TWO\n";

    let dry_run = fixture
        .call("os.fs.patch", serde_json::json!({"patch": valid}))
        .await;
    assert_eq!(dry_run.status, ToolStatus::Ok);
    assert!(dry_run.summary.contains("no files changed"));
    assert_eq!(fixture.workspace.read("one.txt"), b"one\n");

    let rejected = fixture
        .call(
            "os.fs.patch",
            serde_json::json!({"patch": format!("{valid}{invalid}"), "apply": true}),
        )
        .await;
    assert_eq!(rejected.status, ToolStatus::Error);
    assert_eq!(fixture.workspace.read("one.txt"), b"one\n");
    assert_eq!(fixture.workspace.read("two.txt"), b"two\n");

    let second_valid = "--- two.txt\n+++ two.txt\n@@ -1 +1 @@\n-two\n+TWO\n";
    let applied = fixture
        .call(
            "os.fs.patch",
            serde_json::json!({
                "patch": format!("{valid}{second_valid}"),
                "apply": true
            }),
        )
        .await;
    assert_eq!(applied.status, ToolStatus::Ok);
    assert_eq!(fixture.workspace.read("one.txt"), b"ONE\n");
    assert_eq!(fixture.workspace.read("two.txt"), b"TWO\n");
}

#[tokio::test]
async fn filesystem_trash_moves_directories_through_the_native_trash_api() {
    let fixture = ToolFixture::allowed();
    fixture.workspace.write("discard/nested.txt", "recoverable");
    let linux_trash = dirs::home_dir()
        .expect("home directory")
        .join(".local/share/Trash/files");
    let linux_trash_existed = linux_trash.exists();

    let trashed = fixture
        .call("os.fs.trash", serde_json::json!({"path": "discard"}))
        .await;
    assert_eq!(trashed.status, ToolStatus::Ok);
    assert!(!fixture.workspace.path().join("discard").exists());
    assert_eq!(fixture.approval.requests().len(), 1);
    if !linux_trash_existed {
        assert!(
            !linux_trash.exists(),
            "native trash must not create the Linux FreeDesktop trash path"
        );
    }
}

#[tokio::test]
async fn filesystem_text_tools_reject_oversized_files() {
    let fixture = ToolFixture::allowed();
    let oversized = vec![b'a'; 1_048_577];
    fixture.workspace.write("huge.txt", &oversized);

    let grep = fixture
        .call(
            "os.fs.grep",
            serde_json::json!({"pattern": "a", "path": "huge.txt"}),
        )
        .await;
    assert_eq!(grep.status, ToolStatus::Error);
    assert!(grep.summary.contains("text-tool limit"));

    fixture.workspace.write("small.txt", "a\n");
    let diff = fixture
        .call(
            "os.fs.diff",
            serde_json::json!({"pathA": "small.txt", "pathB": "huge.txt"}),
        )
        .await;
    assert_eq!(diff.status, ToolStatus::Error);
    assert!(diff.summary.contains("text-tool limit"));
}

#[tokio::test]
async fn filesystem_write_accepts_empty_content_and_append_mode() {
    let fixture = ToolFixture::allowed();

    let empty = fixture
        .call(
            "os.fs.write",
            serde_json::json!({"path": "empty.txt", "content": ""}),
        )
        .await;
    assert_eq!(empty.status, ToolStatus::Ok);
    assert_eq!(fixture.workspace.read("empty.txt"), b"");

    let initial = fixture
        .call(
            "os.fs.write",
            serde_json::json!({"path": "append.txt", "content": "alpha"}),
        )
        .await;
    assert_eq!(initial.status, ToolStatus::Ok);

    let appended = fixture
        .call(
            "os.fs.write",
            serde_json::json!({
                "path": "append.txt",
                "content": " beta",
                "mode": "append"
            }),
        )
        .await;
    assert_eq!(appended.status, ToolStatus::Ok);
    assert_eq!(fixture.workspace.read("append.txt"), b"alpha beta");

    let missing = fixture
        .call("os.fs.write", serde_json::json!({"path": "missing.txt"}))
        .await;
    assert_eq!(missing.status, ToolStatus::Error);
    assert_eq!(missing.summary, "Missing string argument `content`");
}

#[tokio::test]
async fn filesystem_edit_supports_explicit_replace_all() {
    let fixture = ToolFixture::allowed();
    fixture.workspace.write("repeated.txt", "old old old");

    let ambiguous = fixture
        .call(
            "os.fs.edit",
            serde_json::json!({
                "path": "repeated.txt",
                "oldString": "old",
                "newString": "new"
            }),
        )
        .await;
    assert_eq!(ambiguous.status, ToolStatus::Error);
    assert_eq!(fixture.workspace.read("repeated.txt"), b"old old old");

    let replaced = fixture
        .call(
            "os.fs.edit",
            serde_json::json!({
                "path": "repeated.txt",
                "oldString": "old",
                "newString": "new",
                "replaceAll": true
            }),
        )
        .await;
    assert_eq!(replaced.status, ToolStatus::Ok);
    assert_eq!(fixture.workspace.read("repeated.txt"), b"new new new");
}

#[tokio::test]
async fn destructive_filesystem_calls_reject_invalid_args_before_approval() {
    let fixture = ToolFixture::allowed();
    fixture.workspace.write("editable.txt", "before");
    fixture.workspace.write("archive.zip", []);

    for (tool, args) in [
        (
            "os.fs.write",
            serde_json::json!({"path": "file.txt", "content": "x", "mode": "invalid"}),
        ),
        (
            "os.fs.mkdir",
            serde_json::json!({"path": "dir", "recursive": "yes"}),
        ),
        (
            "os.fs.edit",
            serde_json::json!({
                "path": "editable.txt",
                "oldString": "",
                "newString": "after"
            }),
        ),
        ("os.fs.trash", serde_json::json!({"paths": []})),
        (
            "os.fs.patch",
            serde_json::json!({
                "patch": "--- ../file.txt\n+++ ../file.txt\n@@ -1 +1 @@\n-a\n+b\n",
                "apply": true
            }),
        ),
        (
            "os.fs.archive.extract",
            serde_json::json!({
                "path": "archive.zip",
                "destination": "out",
                "overwrite": "yes"
            }),
        ),
    ] {
        let outcome = fixture.call(tool, args).await;
        assert_eq!(outcome.status, ToolStatus::Error, "{tool}");
    }
    assert!(fixture.approval.requests().is_empty());
}

#[tokio::test]
async fn filesystem_read_document_extracts_docx_and_honors_character_cap() {
    let fixture = ToolFixture::allowed();
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    archive
        .start_file("word/document.xml", zip::write::FileOptions::default())
        .unwrap();
    archive
        .write_all(
            br#"<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Alpha document text</w:t></w:r></w:p></w:body></w:document>"#,
        )
        .unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    fixture.workspace.write("sample.docx", bytes);

    let extracted = fixture
        .call(
            "os.fs.read_document",
            serde_json::json!({"path": "sample.docx", "maxChars": 5}),
        )
        .await;

    assert_eq!(extracted.status, ToolStatus::Ok);
    assert!(extracted.summary.starts_with("Alpha"));
    assert!(extracted.summary.ends_with("[truncated]"));
    assert_eq!(
        extracted
            .details
            .as_ref()
            .and_then(|details| details.get("truncated"))
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
}

#[tokio::test]
async fn filesystem_mkdir_creates_empty_directories_without_approval() {
    let fixture = ToolFixture::allowed();
    let created = fixture
        .call("os.fs.mkdir", serde_json::json!({"path": "parent/empty"}))
        .await;
    assert_eq!(created.status, ToolStatus::Ok);
    let path = fixture.workspace.path().join("parent/empty");
    assert!(path.is_dir());
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
    assert!(fixture.approval.requests().is_empty());

    let non_recursive = fixture
        .call(
            "os.fs.mkdir",
            serde_json::json!({"path": "missing-parent/child", "recursive": false}),
        )
        .await;
    assert_eq!(non_recursive.status, ToolStatus::Error);
    assert!(!fixture.workspace.path().join("missing-parent").exists());

    let denied = ToolFixture::denied();
    let denied_outcome = denied
        .call("os.fs.mkdir", serde_json::json!({"path": "must-not-exist"}))
        .await;
    assert_eq!(denied_outcome.status, ToolStatus::Ok);
    assert!(denied.workspace.path().join("must-not-exist").is_dir());
    assert!(denied.approval.requests().is_empty());
}

#[tokio::test]
async fn process_tools_reject_invalid_kill_before_approval_and_list_deterministically() {
    let fixture = ToolFixture::allowed();
    for args in [
        serde_json::json!({"pid": 0}),
        serde_json::json!({"pid": -1}),
        serde_json::json!({"pid": 42, "signal": "STOP"}),
    ] {
        let outcome = fixture.call("os.proc.kill", args).await;
        assert_eq!(outcome.status, ToolStatus::Error);
    }
    assert!(fixture.approval.requests().is_empty());

    let listed = fixture
        .call("os.proc.list", serde_json::json!({"maxEntries": 20}))
        .await;
    assert_eq!(listed.status, ToolStatus::Ok);
    let pids = listed
        .summary
        .lines()
        .filter_map(|line| line.split('\t').next()?.parse::<u32>().ok())
        .collect::<Vec<_>>();
    assert!(pids.windows(2).all(|pair| pair[0] <= pair[1]));
}

#[tokio::test]
async fn archive_tools_list_read_extract_and_reject_traversal() {
    let fixture = ToolFixture::allowed();
    create_zip(
        &fixture.workspace,
        "safe.zip",
        &[("folder/entry.txt", "ARCHIVE_SENTINEL")],
    );

    let list = fixture
        .call(
            "os.fs.archive.list",
            serde_json::json!({"path": "safe.zip"}),
        )
        .await;
    assert_eq!(list.status, ToolStatus::Ok);
    assert!(list.summary.contains("folder/entry.txt"));

    let read = fixture
        .call(
            "os.fs.archive.read_entry",
            serde_json::json!({"path": "safe.zip", "entry": "folder/entry.txt"}),
        )
        .await;
    assert_eq!(read.summary, "ARCHIVE_SENTINEL");

    let extracted = fixture
        .call(
            "os.fs.archive.extract",
            serde_json::json!({"path": "safe.zip", "destination": "out"}),
        )
        .await;
    assert_eq!(extracted.status, ToolStatus::Ok);
    assert_eq!(
        fixture.workspace.read("out/folder/entry.txt"),
        b"ARCHIVE_SENTINEL"
    );

    create_zip(
        &fixture.workspace,
        "unsafe.zip",
        &[("../escaped.txt", "must-not-escape")],
    );
    let unsafe_extract = fixture
        .call(
            "os.fs.archive.extract",
            serde_json::json!({"path": "unsafe.zip", "destination": "unsafe-out"}),
        )
        .await;
    assert_eq!(unsafe_extract.status, ToolStatus::Error);
    assert!(unsafe_extract.summary.contains("unsafe path"));
    assert!(!fixture.workspace.path().join("escaped.txt").exists());

    create_zip(
        &fixture.workspace,
        "overwrite.zip",
        &[("entry.txt", "replacement")],
    );
    fixture
        .workspace
        .write("overwrite-out/entry.txt", "original");
    let rejected_overwrite = fixture
        .call(
            "os.fs.archive.extract",
            serde_json::json!({
                "path": "overwrite.zip",
                "destination": "overwrite-out"
            }),
        )
        .await;
    assert_eq!(rejected_overwrite.status, ToolStatus::Error);
    assert_eq!(
        fixture.workspace.read("overwrite-out/entry.txt"),
        b"original"
    );

    let allowed_overwrite = fixture
        .call(
            "os.fs.archive.extract",
            serde_json::json!({
                "path": "overwrite.zip",
                "destination": "overwrite-out",
                "overwrite": true
            }),
        )
        .await;
    assert_eq!(allowed_overwrite.status, ToolStatus::Ok);
    assert_eq!(
        fixture.workspace.read("overwrite-out/entry.txt"),
        b"replacement"
    );
}

#[tokio::test]
async fn git_read_tools_report_a_real_repository() {
    let fixture = ToolFixture::allowed();
    fixture.workspace.write("tracked.txt", "line one\n");
    git(&fixture.workspace, &["init"]);
    git(
        &fixture.workspace,
        &["config", "user.name", "Test Operator"],
    );
    git(
        &fixture.workspace,
        &["config", "user.email", "operator@example.invalid"],
    );
    git(&fixture.workspace, &["add", "tracked.txt"]);
    git(&fixture.workspace, &["commit", "-m", "initial fixture"]);
    fixture
        .workspace
        .write("tracked.txt", "line one\nline two\n");

    let status = fixture.call("os.git.status", serde_json::json!({})).await;
    assert_eq!(status.status, ToolStatus::Ok);
    assert!(status.summary.contains("tracked.txt"));

    let log = fixture
        .call("os.git.log", serde_json::json!({"maxCount": 1}))
        .await;
    assert!(log.summary.contains("Test Operator"));
    assert!(log.summary.contains("initial fixture"));

    let diff = fixture
        .call("os.git.diff", serde_json::json!({"path": "tracked.txt"}))
        .await;
    assert!(diff.summary.contains("+line two"));

    let show = fixture
        .call("os.git.show", serde_json::json!({"revision": "HEAD"}))
        .await;
    assert!(show.summary.contains("initial fixture"));

    let blame = fixture
        .call("os.git.blame", serde_json::json!({"path": "tracked.txt"}))
        .await;
    assert!(blame.summary.contains("Test Operator"));

    let branch = fixture.call("os.git.branch", serde_json::json!({})).await;
    assert!(branch.summary.contains('*'));
}

#[tokio::test]
async fn shell_contract_covers_safe_execution_hard_block_denial_and_cancellation() {
    let allowed = ToolFixture::allowed();
    let safe = allowed
        .call(
            "os.shell.run",
            serde_json::json!({"cmd": "printf", "args": ["SHELL_SENTINEL"]}),
        )
        .await;
    assert_eq!(safe.status, ToolStatus::Ok);
    assert_eq!(safe.summary, "SHELL_SENTINEL");
    assert_eq!(allowed.approval.requests().len(), 1);

    let blocked = allowed
        .call(
            "os.shell.run",
            serde_json::json!({"cmd": "echo ready && sudo rm -rf /"}),
        )
        .await;
    assert_eq!(blocked.status, ToolStatus::Denied);
    assert_eq!(allowed.approval.requests().len(), 1);

    let denied = ToolFixture::denied();
    let no_run = denied
        .call(
            "os.shell.run",
            serde_json::json!({"cmd": "printf", "args": ["MUST_NOT_RUN"]}),
        )
        .await;
    assert_eq!(no_run.status, ToolStatus::Denied);

    let cancelled = ToolFixture::allowed();
    cancelled.cancellation.cancel();
    let outcome = cancelled
        .call(
            "os.shell.run",
            serde_json::json!({"cmd": "printf", "args": ["MUST_NOT_RUN"]}),
        )
        .await;
    assert_eq!(outcome.status, ToolStatus::Cancelled);
    assert!(cancelled.approval.requests().is_empty());
}

#[tokio::test]
async fn output_contract_is_bounded() {
    let fixture = ToolFixture::allowed();
    let oversized = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500);
    create_zip(
        &fixture.workspace,
        "large.zip",
        &[("large.txt", &oversized)],
    );
    let outcome = fixture
        .call(
            "os.fs.archive.read_entry",
            serde_json::json!({"path": "large.zip", "entry": "large.txt"}),
        )
        .await;
    assert_eq!(outcome.status, ToolStatus::Ok);
    assert!(outcome.summary.ends_with("[truncated]"));
    assert!(outcome.summary.chars().count() <= MAX_TOOL_OUTPUT_CHARS + 12);
}

#[cfg(unix)]
#[tokio::test]
async fn symlink_escape_requires_folder_access_and_denial_prevents_read() {
    use std::os::unix::fs::symlink;

    let parent = TestWorkspace::new();
    parent.write("outside.txt", "secret");
    std::fs::create_dir(parent.path().join("root")).expect("create trusted root");
    symlink(
        parent.path().join("outside.txt"),
        parent.path().join("root/link.txt"),
    )
    .expect("create symlink");
    let approval = RecordingApproval::deny();
    let desktop = RecordingDesktop::default();
    let cancellation = CancellationToken::new();
    let loaded_tools = LoadedTools::default();
    let loaded_skills = LoadedSkills::default();
    let skill_registry = parent.skill_registry();
    let root = parent.path().join("root");
    let editable_roots = EditableRoots::for_test(&root);
    let folder_access = RecordingFolderAccess::deny();
    let outcome = execute(
        &ToolCallPayload {
            tool: "os.fs.read".into(),
            args: serde_json::json!({"path": "link.txt"}),
        },
        &ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            desktop: &desktop,
        },
    )
    .await;

    assert_eq!(outcome.status, ToolStatus::Denied);
    assert!(approval.requests().is_empty());
    assert_eq!(folder_access.requests().len(), 1);
}

fn create_zip(workspace: &TestWorkspace, relative: &str, entries: &[(&str, &str)]) {
    let file = std::fs::File::create(workspace.path().join(relative)).expect("create zip fixture");
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default();
    for (name, content) in entries {
        archive
            .start_file(*name, options)
            .expect("start zip fixture entry");
        archive
            .write_all(content.as_bytes())
            .expect("write zip fixture entry");
    }
    archive.finish().expect("finish zip fixture");
}

fn git(workspace: &TestWorkspace, args: &[&str]) {
    let mut command = Command::new("git");
    command.args(args);
    if args == ["init"] {
        command.arg("--template=");
    }
    let output = command
        .current_dir(workspace.path())
        .output()
        .expect("run git fixture command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
