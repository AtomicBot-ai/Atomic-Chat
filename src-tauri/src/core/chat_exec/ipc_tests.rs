//! The three commands through Tauri IPC, the way the chat calls them.

use serde_json::{json, Value};

use super::commands::*;
use super::ChatExecState;
use crate::core::threads::commands::*;
use crate::test_support::IpcTestHarness;

fn harness() -> IpcTestHarness {
    IpcTestHarness::new(|builder| {
        builder
            .manage(ChatExecState::default())
            .invoke_handler(tauri::generate_handler![
                chat_exec_status,
                chat_exec_run,
                chat_exec_cancel,
                delete_thread
            ])
    })
}

fn run(harness: &IpcTestHarness, request: Value) -> Result<Value, Value> {
    harness.invoke("chat_exec_run", json!({ "request": request }))
}

#[cfg(unix)]
#[test]
fn reports_what_this_machine_can_run_without_a_sandbox() {
    let harness = harness();
    let status: Value = harness.invoke("chat_exec_status", json!({})).unwrap();

    assert_eq!(status["supported"], true);
    assert_eq!(status["shell"], "sh");
    assert_eq!(status["sandbox"], json!({ "kind": "none", "reason": null }));
    assert!(
        status["languages"]
            .as_array()
            .unwrap()
            .contains(&json!("shell")),
        "{status}"
    );
}

#[cfg(unix)]
#[test]
fn runs_a_command_in_the_threads_own_folder() {
    let harness = harness();
    let result = run(
        &harness,
        json!({
            "callId": "call-1",
            "threadId": "thread-1",
            "kind": "command",
            "source": "echo hello > made.txt && cat made.txt",
        }),
    )
    .unwrap();

    let workdir = harness
        .data_root()
        .join("agent-workspace")
        .join("chat")
        .join("thread-1");
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["stdout"], "hello\n");
    assert_eq!(result["sandbox"], "none");
    assert_eq!(result["workdir"], workdir.display().to_string());
    assert_eq!(
        std::fs::read_to_string(workdir.join("made.txt")).unwrap(),
        "hello\n"
    );
}

#[cfg(unix)]
#[test]
fn runs_a_shell_script_reports_its_exit_code_and_removes_the_file() {
    let harness = harness();
    let result = run(
        &harness,
        json!({
            "callId": "call-2",
            "threadId": "thread-2",
            "kind": "script",
            "language": "shell",
            "source": "echo from-script\necho oops >&2\nexit 4\n",
        }),
    )
    .unwrap();

    assert_eq!(result["exitCode"], 4);
    assert_eq!(result["stdout"], "from-script\n");
    assert_eq!(result["stderr"], "oops\n");
    let scripts = harness
        .data_root()
        .join("agent-workspace/chat/thread-2/.atomic");
    assert_eq!(std::fs::read_dir(scripts).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn stops_a_command_at_its_timeout() {
    let harness = harness();
    let started = std::time::Instant::now();
    let result = run(
        &harness,
        json!({
            "callId": "call-3",
            "threadId": "thread-3",
            "kind": "command",
            "source": "echo before; sleep 30",
            "timeoutSeconds": 1,
        }),
    )
    .unwrap();

    assert_eq!(result["timedOut"], true);
    assert_eq!(result["exitCode"], Value::Null);
    assert_eq!(result["stdout"], "before\n");
    assert!(started.elapsed() < std::time::Duration::from_secs(15));
}

#[test]
fn refuses_what_it_cannot_run_safely() {
    let harness = harness();
    let base = json!({ "callId": "c", "threadId": "t", "kind": "command", "source": "echo hi" });
    let with = |key: &str, value: Value| {
        let mut request = base.clone();
        request[key] = value;
        request
    };

    for request in [
        with("threadId", json!("../escape")),
        with("source", json!("   ")),
        with("kind", json!("script")),
    ] {
        assert!(run(&harness, request.clone()).is_err(), "{request} was run");
    }
    assert!(!harness
        .invoke::<bool>("chat_exec_cancel", json!({ "callId": "nothing-running" }))
        .unwrap());
}

#[cfg(unix)]
#[test]
fn deleting_the_thread_removes_what_its_commands_wrote() {
    let harness = harness();
    run(
        &harness,
        json!({
            "callId": "call-4",
            "threadId": "thread-4",
            "kind": "command",
            "source": "echo kept-until-delete > notes.txt",
        }),
    )
    .unwrap();
    let workdir = harness.data_root().join("agent-workspace/chat/thread-4");
    assert!(workdir.join("notes.txt").is_file());

    harness
        .invoke::<()>("delete_thread", json!({ "threadId": "thread-4" }))
        .unwrap();

    assert!(!workdir.exists());
}
