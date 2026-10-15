//! The real MXC executor on a real Windows. Ignored by default: run them on a
//! Windows 11 24H2+ machine after `yarn download:bin` (which puts the pinned
//! `wxc-exec.exe` in `src-tauri/resources/bin/mxc/`), or point
//! `ATOMIC_TEST_WXC_EXEC` at another copy:
//!
//! `cargo test --lib chat_exec::mxc_windows_tests -- --ignored --test-threads=1`

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use super::{
    mxc::{
        build_policy, cmd_arguments, encode_policy, executor_launch, parse_error, probe,
        quote_windows_arg, system_root, workload_base_env, PolicyInput, HOST_TIMEOUT_GRACE_SECS,
        WXC_EXEC_RESOURCE,
    },
    runner::{self, RunOutput},
};

fn wxc_exec() -> PathBuf {
    let path = std::env::var_os("ATOMIC_TEST_WXC_EXEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(WXC_EXEC_RESOURCE));
    assert!(
        path.metadata().is_ok_and(|meta| meta.len() > 0),
        "no wxc-exec.exe at {}: run `yarn download:bin` or set ATOMIC_TEST_WXC_EXEC",
        path.display()
    );
    path
}

fn policy_for(workdir: &Path, command: &str, timeout_ms: u64) -> String {
    let cmd = system_root().join("System32").join("cmd.exe");
    let command_line = format!(
        "{} {}",
        quote_windows_arg(&cmd.display().to_string()),
        cmd_arguments(command)
    );
    let env = workload_base_env(workdir, &[]);
    let container_id = format!("atomic-test-{}", uuid::Uuid::new_v4().simple());
    encode_policy(&build_policy(&PolicyInput {
        container_id: &container_id,
        command_line: &command_line,
        workdir,
        env: &env,
        readonly_paths: &[system_root()],
        timeout_ms,
    }))
    .unwrap()
}

async fn run_sandboxed(workdir: &Path, command: &str, timeout_ms: u64) -> RunOutput {
    let launch = executor_launch(&wxc_exec(), policy_for(workdir, command, timeout_ms));
    runner::run(
        &launch,
        Duration::from_millis(timeout_ms) + Duration::from_secs(HOST_TIMEOUT_GRACE_SECS),
        &CancellationToken::new(),
    )
    .await
    .unwrap()
}

fn explain(output: &RunOutput) -> String {
    format!(
        "exit {:?}\nstdout:\n{}\nstderr:\n{}",
        output.exit_code, output.stdout, output.stderr
    )
}

/// The request the app sends is valid MXC 1.0.0, before anything runs.
#[tokio::test]
#[ignore]
async fn the_executor_accepts_the_apps_policy() {
    let scratch = tempfile::tempdir().unwrap();
    let mut launch = executor_launch(&wxc_exec(), policy_for(scratch.path(), "echo ok", 10_000));
    launch.args.push("--dry-run".into());

    let output = runner::run(&launch, Duration::from_secs(30), &CancellationToken::new())
        .await
        .unwrap();

    assert_eq!(output.exit_code, Some(0), "{}", explain(&output));
    assert!(
        parse_error(&output.stderr).is_none(),
        "{}",
        explain(&output)
    );
}

/// What the app checks once per session before it offers the sandbox.
#[tokio::test]
#[ignore]
async fn this_machine_passes_the_apps_sandbox_probe() {
    let scratch = tempfile::tempdir().unwrap();
    probe(&wxc_exec(), scratch.path()).await.unwrap();
}

#[tokio::test]
#[ignore]
async fn a_command_writes_only_inside_its_folder_and_cannot_read_next_to_it() {
    let scratch = tempfile::tempdir().unwrap();
    let workdir = scratch.path().join("chat");
    std::fs::create_dir_all(&workdir).unwrap();
    let secret = scratch.path().join("secret.txt");
    std::fs::write(&secret, "ATOMIC-SECRET-CANARY").unwrap();
    let escape = scratch.path().join("escape.txt");

    let output = run_sandboxed(
        &workdir,
        &format!(
            "echo inside>inside.txt & type \"{}\" & echo escape>\"{}\" & echo done",
            secret.display(),
            escape.display()
        ),
        20_000,
    )
    .await;

    assert!(output.stdout.contains("done"), "{}", explain(&output));
    assert!(workdir.join("inside.txt").is_file(), "{}", explain(&output));
    assert!(
        !output.stdout.contains("ATOMIC-SECRET-CANARY"),
        "{}",
        explain(&output)
    );
    assert!(!escape.exists(), "{}", explain(&output));
}

#[tokio::test]
#[ignore]
async fn mxc_stops_a_command_at_the_policy_timeout() {
    let scratch = tempfile::tempdir().unwrap();
    let started = std::time::Instant::now();

    let output = run_sandboxed(
        scratch.path(),
        "powershell.exe -NoProfile -Command Start-Sleep -Seconds 60",
        3_000,
    )
    .await;

    assert_ne!(output.exit_code, Some(0), "{}", explain(&output));
    assert!(
        started.elapsed() < Duration::from_secs(HOST_TIMEOUT_GRACE_SECS),
        "MXC did not stop it; the host did after {:?}\n{}",
        started.elapsed(),
        explain(&output)
    );
}

/// Needs internet access on the test machine.
#[tokio::test]
#[ignore]
async fn a_command_reaches_the_internet() {
    let scratch = tempfile::tempdir().unwrap();

    let output = run_sandboxed(
        scratch.path(),
        "curl.exe -sS -o NUL -I https://www.microsoft.com && echo reached",
        30_000,
    )
    .await;

    assert!(output.stdout.contains("reached"), "{}", explain(&output));
}
