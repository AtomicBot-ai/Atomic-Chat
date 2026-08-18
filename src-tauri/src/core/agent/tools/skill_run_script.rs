use std::{
    io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

use serde_json::Value;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

use super::{command_outcome, required_string, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::{skills::SkillRegistry, types::ToolOutcome};

const MAX_SCRIPT_OUTPUT_BYTES: usize = MAX_TOOL_OUTPUT_CHARS;

struct BoundedOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}

pub struct SkillScriptInvocation {
    pub skill_name: String,
    pub script_name: String,
    pub skill_root: PathBuf,
    pub script_path: PathBuf,
    pub program: String,
    pub arguments: Vec<String>,
    pub timeout_ms: u64,
}

pub async fn prepare(
    args: &Value,
    registry: &SkillRegistry,
    bundled_script_runtime: Option<&Path>,
) -> Result<SkillScriptInvocation, ToolOutcome> {
    let skill_name = required_string(args, "skill").map_err(ToolOutcome::error)?;
    let script_name = required_string(args, "script").map_err(ToolOutcome::error)?;
    let script_args = optional_string_array(args, "args")?;
    let timeout_ms = args
        .get("timeout_ms")
        .or_else(|| args.get("timeoutMs"))
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .clamp(1_000, 600_000);
    let Some(record) = registry.get_enabled(&skill_name) else {
        return Err(ToolOutcome::error(format!(
            "Skill `{skill_name}` is missing, disabled, incompatible, or unavailable"
        )));
    };
    if !record
        .manifest
        .requires_scripts
        .iter()
        .any(|declared| declared == &script_name)
    {
        let guidance = if record.manifest.requires_scripts.is_empty() {
            "This skill declares no bundled scripts. Use its declared tools instead; external CLI commands must use `os.shell.run` with the executable in `cmd` and separate `args`."
                .to_string()
        } else {
            format!(
                "Use an exact declared filename in `script` and pass command arguments through `args`. Declared scripts: {}.",
                record.manifest.requires_scripts.join(", ")
            )
        };
        return Err(ToolOutcome::error(format!(
            "Skill `{skill_name}` does not declare script `{script_name}` in requires_scripts. {guidance}"
        )));
    }
    let scripts_root = tokio::fs::canonicalize(record.root.join("scripts"))
        .await
        .map_err(|error| {
            ToolOutcome::error(format!(
                "Could not resolve skill scripts directory: {error}"
            ))
        })?;
    if scripts_root.parent() != Some(record.root.as_path()) {
        return Err(ToolOutcome::error(
            "Skill scripts directory must not be a symlink or escape the skill root",
        ));
    }
    let requested = scripts_root.join(&script_name);
    let script_path = tokio::fs::canonicalize(&requested)
        .await
        .map_err(|error| ToolOutcome::error(format!("Skill script not found: {error}")))?;
    if !script_path.starts_with(&scripts_root) || !is_direct_or_nested_file(&script_path).await {
        return Err(ToolOutcome::error(
            "Skill script path escapes scripts/ or is not a file",
        ));
    }
    let (program, arguments) =
        interpreter_invocation(&script_path, script_args, bundled_script_runtime)?;
    Ok(SkillScriptInvocation {
        skill_name,
        script_name,
        skill_root: record.root.clone(),
        script_path,
        program,
        arguments,
        timeout_ms,
    })
}

pub async fn execute(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let invocation = prepare(args, context.skill_registry, context.bundled_script_runtime).await?;
    run_invocation(&invocation, context.cancellation).await
}

async fn run_invocation(
    invocation: &SkillScriptInvocation,
    cancellation: &CancellationToken,
) -> Result<ToolOutcome, ToolOutcome> {
    let mut command = command_for(invocation);
    command
        .current_dir(&invocation.skill_root)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_tree(&mut command);
    let mut child = command.spawn().map_err(|error| {
        ToolOutcome::error(format!(
            "Could not run interpreter `{}`: {error}",
            invocation.program
        ))
    })?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ToolOutcome::error("Could not capture skill script stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ToolOutcome::error("Could not capture skill script stderr"))?;
    let (overflow_tx, mut overflow_rx) = mpsc::channel(1);
    let output_bytes = Arc::new(AtomicUsize::new(0));
    let stdout_task = tokio::spawn(read_bounded_output(
        stdout,
        Arc::clone(&output_bytes),
        overflow_tx.clone(),
    ));
    let stderr_task = tokio::spawn(read_bounded_output(stderr, output_bytes, overflow_tx));

    let status: ExitStatus = tokio::select! {
        _ = cancellation.cancelled() => {
            terminate_process_tree(&mut child, pid).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(ToolOutcome {
                status: crate::core::agent::types::ToolStatus::Cancelled,
                summary: "Skill script cancelled".into(),
                details: None,
            });
        }
        _ = tokio::time::sleep(std::time::Duration::from_millis(invocation.timeout_ms)) => {
            terminate_process_tree(&mut child, pid).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(ToolOutcome::error(format!(
                "Skill script timed out after {}ms",
                invocation.timeout_ms
            )));
        }
        Some(()) = overflow_rx.recv() => {
            terminate_process_tree(&mut child, pid).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(ToolOutcome::error(format!(
                "Skill script exceeded the {}-byte output limit",
                MAX_SCRIPT_OUTPUT_BYTES
            )));
        }
        result = child.wait() => result.map_err(|error| {
            ToolOutcome::error(format!(
                "Could not wait for interpreter `{}`: {error}",
                invocation.program
            ))
        })?,
    };
    let stdout = join_output(stdout_task, "stdout").await?;
    let stderr = join_output(stderr_task, "stderr").await?;
    if stdout.overflowed || stderr.overflowed {
        return Err(ToolOutcome::error(format!(
            "Skill script exceeded the {}-byte output limit",
            MAX_SCRIPT_OUTPUT_BYTES
        )));
    }
    let outcome = command_outcome(std::process::Output {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    });
    Ok(match outcome {
        Ok(mut value) => {
            value.summary = format!(
                "# {}/{}\n{}",
                invocation.skill_name, invocation.script_name, value.summary
            );
            value
        }
        Err(mut value) => {
            value.summary = format!(
                "# {}/{}\n{}",
                invocation.skill_name, invocation.script_name, value.summary
            );
            value
        }
    })
}

async fn read_bounded_output(
    mut stream: impl AsyncRead + Unpin,
    total_bytes: Arc<AtomicUsize>,
    overflow: mpsc::Sender<()>,
) -> io::Result<BoundedOutput> {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(BoundedOutput {
                bytes: output,
                overflowed: false,
            });
        }
        let previous = total_bytes.fetch_add(read, Ordering::AcqRel);
        if previous.saturating_add(read) > MAX_SCRIPT_OUTPUT_BYTES {
            let remaining = MAX_SCRIPT_OUTPUT_BYTES.saturating_sub(previous);
            output.extend_from_slice(&chunk[..remaining]);
            let _ = overflow.try_send(());
            return Ok(BoundedOutput {
                bytes: output,
                overflowed: true,
            });
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

async fn join_output(
    task: tokio::task::JoinHandle<io::Result<BoundedOutput>>,
    stream: &str,
) -> Result<BoundedOutput, ToolOutcome> {
    task.await
        .map_err(|error| ToolOutcome::error(format!("Could not join {stream} reader: {error}")))?
        .map_err(|error| ToolOutcome::error(format!("Could not read script {stream}: {error}")))
}

#[cfg(unix)]
fn configure_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.as_std_mut().pre_exec(|| {
            nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))
                .map_err(|error| io::Error::from_raw_os_error(error as i32))
        });
    }
}

#[cfg(windows)]
fn configure_process_tree(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command
        .as_std_mut()
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
fn configure_process_tree(_command: &mut Command) {}

async fn terminate_process_tree(child: &mut Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|value| i32::try_from(value).ok()) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGKILL,
        );
    }

    #[cfg(windows)]
    if let Some(pid) = pid {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        use std::os::windows::process::CommandExt;
        taskkill.as_std_mut().creation_flags(0x0800_0000);
        let _ = taskkill.status().await;
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn optional_string_array(args: &Value, key: &str) -> Result<Vec<String>, ToolOutcome> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| ToolOutcome::error("Every script arg must be a string"))
            })
            .collect(),
        Some(_) => Err(ToolOutcome::error("`args` must be an array of strings")),
    }
}

fn interpreter_invocation(
    script_path: &Path,
    user_args: Vec<String>,
    bundled_script_runtime: Option<&Path>,
) -> Result<(String, Vec<String>), ToolOutcome> {
    let extension = script_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let path = script_path.display().to_string();
    let invocation = match extension.as_str() {
        "sh" => ("bash".into(), prepend(path, user_args)),
        "ps1" => (
            if cfg!(windows) {
                "powershell.exe".into()
            } else {
                "pwsh".into()
            },
            ["-NoProfile".into(), "-File".into(), path]
                .into_iter()
                .chain(user_args)
                .collect(),
        ),
        "js" | "mjs" | "cjs" | "ts" => (
            bundled_script_runtime
                .filter(|runtime| runtime.is_file())
                .map_or_else(|| "bun".into(), |runtime| runtime.display().to_string()),
            prepend(path, user_args),
        ),
        "cmd" | "bat" if cfg!(windows) => (
            "cmd.exe".into(),
            ["/C".into(), path].into_iter().chain(user_args).collect(),
        ),
        "cmd" | "bat" => {
            return Err(ToolOutcome::error(
                "Windows batch scripts cannot run on this platform",
            ))
        }
        _ => (path, user_args),
    };
    Ok(invocation)
}

fn prepend(first: String, rest: Vec<String>) -> Vec<String> {
    std::iter::once(first).chain(rest).collect()
}

fn command_for(invocation: &SkillScriptInvocation) -> Command {
    let mut command = Command::new(&invocation.program);
    command.args(&invocation.arguments);
    command
}

async fn is_direct_or_nested_file(path: &Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_file())
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, fs};

    use tempfile::TempDir;

    use super::*;

    fn registry_with_script(temp: &TempDir, script: &str, contents: &str) -> SkillRegistry {
        let root = temp.path().join("skills");
        let skill_root = root.join("test-skill");
        fs::create_dir_all(skill_root.join("scripts")).unwrap();
        fs::write(skill_root.join("scripts").join(script), contents).unwrap();
        fs::write(
            skill_root.join("SKILL.md"),
            format!(
                "---\nname: test-skill\ndescription: Test\nrequires_scripts: [{script}]\n---\nBody"
            ),
        )
        .unwrap();
        SkillRegistry::load(root, &BTreeSet::new(), &BTreeSet::new()).unwrap()
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
    async fn prepares_only_declared_scripts_and_bounds_timeout() {
        let temp = TempDir::new().unwrap();
        let registry = registry_with_script(&temp, "inspect.sh", "echo ok");
        let invocation = prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "inspect.sh",
                "args": ["one"],
                "timeout_ms": 1
            }),
            &registry,
            None,
        )
        .await
        .unwrap();
        assert_eq!(invocation.program, "bash");
        assert_eq!(invocation.timeout_ms, 1_000);
        assert_eq!(invocation.arguments.last().unwrap(), "one");

        assert!(prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "other.sh"
            }),
            &registry,
            None,
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn redirects_external_commands_to_shell_run_when_no_scripts_are_declared() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let skill_root = root.join("test-skill");
        fs::create_dir_all(&skill_root).unwrap();
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test\nrequires_tools: [os.shell.run]\n---\nBody",
        )
        .unwrap();
        let available_tools = BTreeSet::from(["os.shell.run".to_string()]);
        let registry = SkillRegistry::load(root, &BTreeSet::new(), &available_tools).unwrap();

        let outcome = match prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "memo notes -a title"
            }),
            &registry,
            None,
        )
        .await
        {
            Ok(_) => panic!("external command must not be accepted as a bundled script"),
            Err(outcome) => outcome,
        };

        assert!(outcome.summary.contains("declares no bundled scripts"));
        assert!(outcome.summary.contains("`os.shell.run`"));
        assert!(outcome.summary.contains("separate `args`"));
    }

    #[tokio::test]
    async fn prefers_the_bundled_runtime_for_javascript() {
        let temp = TempDir::new().unwrap();
        let registry = registry_with_script(&temp, "inspect.js", "console.log('ok')");
        let runtime = temp
            .path()
            .join(if cfg!(windows) { "bun.exe" } else { "bun" });
        fs::write(&runtime, []).unwrap();

        let invocation = prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "inspect.js"
            }),
            &registry,
            Some(&runtime),
        )
        .await
        .unwrap();

        assert_eq!(invocation.program, runtime.display().to_string());
    }

    #[tokio::test]
    async fn reports_script_timeout() {
        let temp = TempDir::new().unwrap();
        // On Windows `bash` resolves to the System32 WSL stub, which exits
        // immediately when no distribution is installed — use cmd.exe there.
        let (program, arguments) = if cfg!(windows) {
            (
                "cmd.exe".to_string(),
                vec!["/C".into(), "ping -n 30 127.0.0.1 >nul".into()],
            )
        } else {
            ("bash".to_string(), vec!["-c".into(), "sleep 2".into()])
        };
        let invocation = SkillScriptInvocation {
            skill_name: "test-skill".into(),
            script_name: "slow.sh".into(),
            skill_root: temp.path().to_path_buf(),
            script_path: temp.path().join("slow.sh"),
            program,
            arguments,
            timeout_ms: 1_000,
        };
        let error = run_invocation(&invocation, &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.summary.contains("timed out after 1000ms"));
    }

    #[tokio::test]
    async fn reports_a_missing_script_interpreter() {
        let temp = TempDir::new().unwrap();
        let invocation = SkillScriptInvocation {
            skill_name: "test-skill".into(),
            script_name: "missing-runtime".into(),
            skill_root: temp.path().to_path_buf(),
            script_path: temp.path().join("missing-runtime"),
            program: temp
                .path()
                .join("runtime-that-does-not-exist")
                .display()
                .to_string(),
            arguments: Vec::new(),
            timeout_ms: 1_000,
        };

        let error = run_invocation(&invocation, &CancellationToken::new())
            .await
            .unwrap_err();

        assert!(error.summary.contains("Could not run interpreter"));
    }

    #[tokio::test]
    async fn terminates_scripts_that_exceed_the_output_limit() {
        let temp = TempDir::new().unwrap();
        // Same WSL-stub problem as `reports_script_timeout`: spell the
        // infinite-output loop in cmd.exe on Windows.
        let (program, arguments) = if cfg!(windows) {
            (
                "cmd.exe".to_string(),
                vec![
                    "/C".into(),
                    "for /L %i in (0,0,1) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        .into(),
                ],
            )
        } else {
            (
                "bash".to_string(),
                vec![
                    "-c".into(),
                    "while true; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done".into(),
                ],
            )
        };
        let invocation = SkillScriptInvocation {
            skill_name: "test-skill".into(),
            script_name: "noisy.sh".into(),
            skill_root: temp.path().to_path_buf(),
            script_path: temp.path().join("noisy.sh"),
            program,
            arguments,
            timeout_ms: 5_000,
        };

        let error = run_invocation(&invocation, &CancellationToken::new())
            .await
            .unwrap_err();

        assert!(error.summary.contains("output limit"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_terminates_descendant_processes() {
        use std::time::Duration;

        use nix::{sys::signal, unistd::Pid};

        let temp = TempDir::new().unwrap();
        let child_pid_file = temp.path().join("child.pid");
        let invocation = SkillScriptInvocation {
            skill_name: "test-skill".into(),
            script_name: "tree.sh".into(),
            skill_root: temp.path().to_path_buf(),
            script_path: temp.path().join("tree.sh"),
            program: "bash".into(),
            arguments: vec![
                "-c".into(),
                "sleep 30 & echo $! > \"$1\"; wait".into(),
                "skill-tree-test".into(),
                child_pid_file.display().to_string(),
            ],
            timeout_ms: 1_000,
        };

        let error = run_invocation(&invocation, &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.summary.contains("timed out"));

        let child_pid = fs::read_to_string(child_pid_file)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let mut alive = true;
        for _ in 0..20 {
            alive = signal::kill(Pid::from_raw(child_pid), None).is_ok();
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!alive, "descendant process {child_pid} survived timeout");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_terminates_descendant_processes() {
        use std::time::Duration;

        use nix::{sys::signal, unistd::Pid};

        let temp = TempDir::new().unwrap();
        let child_pid_file = temp.path().join("cancelled-child.pid");
        let invocation = SkillScriptInvocation {
            skill_name: "test-skill".into(),
            script_name: "tree.sh".into(),
            skill_root: temp.path().to_path_buf(),
            script_path: temp.path().join("tree.sh"),
            program: "bash".into(),
            arguments: vec![
                "-c".into(),
                "sleep 30 & echo $! > \"$1\"; wait".into(),
                "skill-tree-test".into(),
                child_pid_file.display().to_string(),
            ],
            timeout_ms: 5_000,
        };
        let cancellation = CancellationToken::new();
        let cancel = cancellation.clone();
        let cancel_when_started = async {
            for _ in 0..100 {
                if child_pid_file.exists() {
                    cancel.cancel();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("descendant process did not start");
        };

        let (result, ()) = tokio::join!(
            run_invocation(&invocation, &cancellation),
            cancel_when_started
        );
        assert_eq!(
            result.unwrap_err().status,
            crate::core::agent::types::ToolStatus::Cancelled
        );

        let child_pid = fs::read_to_string(child_pid_file)
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        let mut alive = true;
        for _ in 0..20 {
            alive = signal::kill(Pid::from_raw(child_pid), None).is_ok();
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !alive,
            "descendant process {child_pid} survived cancellation"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let registry = registry_with_script(&temp, "escape.sh", "echo ok");
        let outside = temp.path().join("outside.sh");
        fs::write(&outside, "echo outside").unwrap();
        let root = temp.path().join("skills/test-skill/scripts/escape.sh");
        fs::remove_file(&root).unwrap();
        symlink(&outside, &root).unwrap();

        assert!(prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "escape.sh"
            }),
            &registry,
            None,
        )
        .await
        .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_symlinked_scripts_directory() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let skill_root = root.join("test-skill");
        let outside = temp.path().join("outside-scripts");
        fs::create_dir_all(&skill_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("escape.sh"), "echo outside").unwrap();
        symlink(&outside, skill_root.join("scripts")).unwrap();
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test\nrequires_scripts: [escape.sh]\n---\nBody",
        )
        .unwrap();
        let registry = SkillRegistry::load(root, &BTreeSet::new(), &BTreeSet::new()).unwrap();

        assert!(prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "escape.sh"
            }),
            &registry,
            None,
        )
        .await
        .is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn rejects_junctioned_scripts_directory() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let skill_root = root.join("test-skill");
        let outside = temp.path().join("outside-scripts");
        fs::create_dir_all(&skill_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("escape.cmd"), "@echo outside").unwrap();
        let junction = skill_root.join("scripts");
        create_junction(&junction, &outside);
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test\nrequires_scripts: [escape.cmd]\n---\nBody",
        )
        .unwrap();
        let registry = SkillRegistry::load(root, &BTreeSet::new(), &BTreeSet::new()).unwrap();

        assert!(prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "escape.cmd"
            }),
            &registry,
            None,
        )
        .await
        .is_err());

        fs::remove_dir(&junction).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn rejects_symlinked_scripts_directory_when_creation_is_allowed() {
        use std::os::windows::fs::symlink_dir;

        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let skill_root = root.join("test-skill");
        let outside = temp.path().join("outside-scripts");
        fs::create_dir_all(&skill_root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("escape.cmd"), "@echo outside").unwrap();
        let link = skill_root.join("scripts");
        if let Err(error) = symlink_dir(&outside, &link) {
            if error.kind() == io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(1314)
            {
                return;
            }
            panic!("could not create directory symlink fixture: {error}");
        }
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test\nrequires_scripts: [escape.cmd]\n---\nBody",
        )
        .unwrap();
        let registry = SkillRegistry::load(root, &BTreeSet::new(), &BTreeSet::new()).unwrap();

        assert!(prepare(
            &serde_json::json!({
                "skill": "test-skill",
                "script": "escape.cmd"
            }),
            &registry,
            None,
        )
        .await
        .is_err());

        fs::remove_dir(&link).unwrap();
    }
}
