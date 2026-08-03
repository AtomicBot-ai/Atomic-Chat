use std::fs;

use serde_json::{json, Value};

use super::commands::*;
use super::utils::{get_messages_path, get_thread_dir, get_thread_metadata_path};
use crate::test_support::IpcTestHarness;

fn harness() -> IpcTestHarness {
    IpcTestHarness::new(|builder| {
        builder.invoke_handler(tauri::generate_handler![
            list_threads,
            create_thread,
            modify_thread,
            delete_thread,
            list_messages,
            create_message,
            modify_message,
            delete_message,
            get_thread_assistant,
            create_thread_assistant,
            modify_thread_assistant,
        ])
    })
}

fn thread(title: &str) -> Value {
    json!({
        "object": "thread",
        "title": title,
        "assistants": [],
        "created": 123,
        "updated": 123,
        "metadata": null
    })
}

fn message(thread_id: &str, text: &str) -> Value {
    json!({
        "object": "message",
        "thread_id": thread_id,
        "role": "user",
        "content": [{"type": "text", "text": text}],
        "status": "sent",
        "created_at": 123,
        "completed_at": 123,
        "metadata": null
    })
}

fn create_thread_over_ipc(harness: &IpcTestHarness, title: &str) -> Value {
    harness
        .invoke("create_thread", json!({"thread": thread(title)}))
        .unwrap()
}

#[test]
fn exercises_the_thread_lifecycle_through_ipc() {
    let harness = harness();
    let empty: Vec<Value> = harness.invoke("list_threads", json!({})).unwrap();
    assert!(empty.is_empty());

    let created = create_thread_over_ipc(&harness, "Original");
    let thread_id = created["id"].as_str().unwrap().to_string();
    assert!(!thread_id.is_empty());
    assert!(get_thread_metadata_path(harness.data_root(), &thread_id).exists());

    let mut modified = created;
    modified["title"] = json!("Modified");
    let result: () = harness
        .invoke("modify_thread", json!({"thread": modified}))
        .unwrap();
    assert_eq!(result, ());

    let listed: Vec<Value> = harness.invoke("list_threads", json!({})).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["title"], "Modified");

    let wrong_case: Result<(), Value> =
        harness.invoke("delete_thread", json!({"thread_id": &thread_id}));
    assert!(wrong_case.is_err());

    let result: () = harness
        .invoke("delete_thread", json!({"threadId": &thread_id}))
        .unwrap();
    assert_eq!(result, ());
    let result: () = harness
        .invoke("delete_thread", json!({"threadId": &thread_id}))
        .unwrap();
    assert_eq!(result, ());
    assert!(!get_thread_dir(harness.data_root(), &thread_id).exists());
}

#[test]
fn serializes_thread_errors_and_skips_corrupt_metadata() {
    let harness = harness();
    let missing_id: Result<(), Value> =
        harness.invoke("modify_thread", json!({"thread": {"title": "Missing id"}}));
    assert_eq!(missing_id, Err(Value::String("Missing thread id".into())));

    let valid = create_thread_over_ipc(&harness, "Valid");
    let corrupt_dir = get_thread_dir(harness.data_root(), "corrupt");
    fs::create_dir_all(&corrupt_dir).unwrap();
    fs::write(corrupt_dir.join("thread.json"), "{not-json").unwrap();

    let listed: Vec<Value> = harness.invoke("list_threads", json!({})).unwrap();
    assert_eq!(listed, vec![valid]);
}

#[test]
fn exercises_the_message_lifecycle_through_ipc() {
    let harness = harness();
    let created_thread = create_thread_over_ipc(&harness, "Messages");
    let thread_id = created_thread["id"].as_str().unwrap();

    let empty: Vec<Value> = harness
        .invoke("list_messages", json!({"threadId": thread_id}))
        .unwrap();
    assert!(empty.is_empty());

    let created: Value = harness
        .invoke(
            "create_message",
            json!({"message": message(thread_id, "Original")}),
        )
        .unwrap();
    let message_id = created["id"].as_str().unwrap();
    assert!(!message_id.is_empty());

    let mut modified = created.clone();
    modified["content"] = json!([{"type": "text", "text": "Modified"}]);
    let response: Value = harness
        .invoke("modify_message", json!({"message": modified.clone()}))
        .unwrap();
    assert_eq!(response, modified);

    let unknown = json!({
        "id": "missing",
        "thread_id": thread_id,
        "role": "user",
        "content": []
    });
    let response: Value = harness
        .invoke("modify_message", json!({"message": unknown.clone()}))
        .unwrap();
    assert_eq!(response, unknown);

    let listed: Vec<Value> = harness
        .invoke("list_messages", json!({"threadId": thread_id}))
        .unwrap();
    assert_eq!(listed, vec![modified]);

    let result: () = harness
        .invoke(
            "delete_message",
            json!({"threadId": thread_id, "messageId": message_id}),
        )
        .unwrap();
    assert_eq!(result, ());
    let listed: Vec<Value> = harness
        .invoke("list_messages", json!({"threadId": thread_id}))
        .unwrap();
    assert!(listed.is_empty());
}

#[test]
fn serializes_message_errors_and_malformed_jsonl() {
    let harness = harness();
    let missing_thread: Result<Value, Value> =
        harness.invoke("create_message", json!({"message": {"role": "user"}}));
    assert_eq!(
        missing_thread,
        Err(Value::String("Missing thread_id".into()))
    );

    let thread_id = "malformed";
    fs::create_dir_all(get_thread_dir(harness.data_root(), thread_id)).unwrap();
    fs::write(
        get_messages_path(harness.data_root(), thread_id),
        "{not-json\n",
    )
    .unwrap();
    let malformed: Result<Vec<Value>, Value> =
        harness.invoke("list_messages", json!({"threadId": thread_id}));
    assert!(malformed.is_err());
}

#[test]
fn exercises_the_assistant_lifecycle_through_ipc() {
    let harness = harness();
    let created_thread = create_thread_over_ipc(&harness, "Assistants");
    let thread_id = created_thread["id"].as_str().unwrap();

    let missing: Result<Value, Value> =
        harness.invoke("get_thread_assistant", json!({"threadId": thread_id}));
    assert_eq!(missing, Err(Value::String("Assistant not found".into())));

    let assistant = json!({"id": "assistant-1", "name": "Original"});
    let response: Value = harness
        .invoke(
            "create_thread_assistant",
            json!({"threadId": thread_id, "assistant": assistant.clone()}),
        )
        .unwrap();
    assert_eq!(response, assistant);

    let fetched: Value = harness
        .invoke("get_thread_assistant", json!({"threadId": thread_id}))
        .unwrap();
    assert_eq!(fetched, assistant);

    let modified = json!({"id": "assistant-1", "name": "Modified"});
    let response: Value = harness
        .invoke(
            "modify_thread_assistant",
            json!({"threadId": thread_id, "assistant": modified.clone()}),
        )
        .unwrap();
    assert_eq!(response, modified);

    let unknown = json!({"id": "missing", "name": "Unknown"});
    let response: Value = harness
        .invoke(
            "modify_thread_assistant",
            json!({"threadId": thread_id, "assistant": unknown.clone()}),
        )
        .unwrap();
    assert_eq!(response, unknown);

    let fetched: Value = harness
        .invoke("get_thread_assistant", json!({"threadId": thread_id}))
        .unwrap();
    assert_eq!(fetched, modified);
}

#[test]
fn serializes_assistant_not_found_errors() {
    let harness = harness();
    let assistant = json!({"id": "assistant-1"});

    let get_error: Result<Value, Value> =
        harness.invoke("get_thread_assistant", json!({"threadId": "missing"}));
    assert_eq!(get_error, Err(Value::String("Thread not found".into())));

    let create_error: Result<Value, Value> = harness.invoke(
        "create_thread_assistant",
        json!({"threadId": "missing", "assistant": assistant.clone()}),
    );
    assert_eq!(create_error, Err(Value::String("Thread not found".into())));

    let modify_error: Result<Value, Value> = harness.invoke(
        "modify_thread_assistant",
        json!({"threadId": "missing", "assistant": assistant}),
    );
    assert_eq!(modify_error, Err(Value::String("Thread not found".into())));
}
