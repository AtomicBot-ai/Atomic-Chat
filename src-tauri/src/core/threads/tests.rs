use std::fs;

use futures_util::future;
use serde_json::json;
use tempfile::tempdir;

use super::file_store::*;
use super::helpers::should_use_sqlite;
use super::utils::{get_messages_path, get_thread_dir, get_thread_metadata_path};

fn test_thread(title: &str) -> serde_json::Value {
    json!({
        "object": "thread",
        "title": title,
        "assistants": [],
        "created": 123,
        "updated": 123,
        "metadata": null
    })
}

fn test_message(thread_id: &str, text: &str) -> serde_json::Value {
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

#[test]
fn creates_lists_modifies_and_deletes_threads() {
    let root = tempdir().unwrap();
    let created = create_thread(root.path(), test_thread("Original")).unwrap();
    let thread_id = created["id"].as_str().unwrap();

    let mut modified = created.clone();
    modified["title"] = json!("Modified");
    modify_thread(root.path(), modified).unwrap();

    let threads = list_threads(root.path()).unwrap();
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0]["title"], "Modified");

    delete_thread(root.path(), thread_id).unwrap();
    delete_thread(root.path(), thread_id).unwrap();
    assert!(!get_thread_dir(root.path(), thread_id).exists());
}

#[test]
fn reports_thread_update_errors() {
    let root = tempdir().unwrap();
    assert_eq!(
        modify_thread(root.path(), json!({"title": "No id"})),
        Err("Missing thread id".to_string())
    );
    assert_eq!(
        modify_thread(root.path(), json!({"id": "missing"})),
        Err("Thread directory does not exist".to_string())
    );
}

#[test]
fn skips_corrupt_thread_metadata() {
    let root = tempdir().unwrap();
    let valid = create_thread(root.path(), test_thread("Valid")).unwrap();
    let corrupt_dir = get_thread_dir(root.path(), "corrupt");
    fs::create_dir_all(&corrupt_dir).unwrap();
    fs::write(corrupt_dir.join("thread.json"), "{not-json").unwrap();

    let threads = list_threads(root.path()).unwrap();
    assert_eq!(threads, vec![valid]);
}

#[tokio::test]
async fn creates_lists_modifies_and_deletes_messages() {
    let root = tempdir().unwrap();
    let thread = create_thread(root.path(), test_thread("Messages")).unwrap();
    let thread_id = thread["id"].as_str().unwrap();

    let created = create_message(root.path(), test_message(thread_id, "Original"))
        .await
        .unwrap();
    let message_id = created["id"].as_str().unwrap();
    assert!(!message_id.is_empty());

    let mut modified = created.clone();
    modified["content"] = json!([{"type": "text", "text": "Modified"}]);
    modify_message(root.path(), modified).await.unwrap();

    let messages = list_messages(root.path(), thread_id).unwrap();
    assert_eq!(messages[0]["content"][0]["text"], "Modified");

    delete_message(root.path(), thread_id, message_id)
        .await
        .unwrap();
    assert!(list_messages(root.path(), thread_id).unwrap().is_empty());
}

#[tokio::test]
async fn preserves_message_no_op_and_validation_contracts() {
    let root = tempdir().unwrap();
    let thread = create_thread(root.path(), test_thread("Messages")).unwrap();
    let thread_id = thread["id"].as_str().unwrap();
    let original = create_message(root.path(), test_message(thread_id, "Original"))
        .await
        .unwrap();

    let unknown = test_message(thread_id, "Unknown");
    let mut unknown = unknown;
    unknown["id"] = json!("missing");
    assert_eq!(
        modify_message(root.path(), unknown.clone()).await.unwrap(),
        unknown
    );
    assert_eq!(
        list_messages(root.path(), thread_id).unwrap(),
        vec![original]
    );

    assert_eq!(
        create_message(root.path(), json!({"role": "user"})).await,
        Err("Missing thread_id".to_string())
    );
    assert_eq!(
        modify_message(root.path(), json!({"thread_id": thread_id})).await,
        Err("Missing message id".to_string())
    );
}

#[test]
fn reports_malformed_message_jsonl() {
    let root = tempdir().unwrap();
    let thread_id = "malformed";
    let thread_dir = get_thread_dir(root.path(), thread_id);
    fs::create_dir_all(&thread_dir).unwrap();
    fs::write(get_messages_path(root.path(), thread_id), "{not-json\n").unwrap();

    assert!(list_messages(root.path(), thread_id).is_err());
}

#[tokio::test]
async fn serializes_concurrent_message_writes_per_thread() {
    let root = tempdir().unwrap();
    let thread = create_thread(root.path(), test_thread("Concurrent")).unwrap();
    let thread_id = thread["id"].as_str().unwrap().to_string();
    let data_folder = root.path().to_path_buf();

    let handles: Vec<_> = (0..5)
        .map(|index| {
            let data_folder = data_folder.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move {
                create_message(
                    &data_folder,
                    test_message(&thread_id, &format!("Message {index}")),
                )
                .await
            })
        })
        .collect();

    let results = future::join_all(handles).await;
    assert!(results
        .iter()
        .all(|result| result.is_ok() && result.as_ref().unwrap().is_ok()));
    assert_eq!(list_messages(root.path(), &thread_id).unwrap().len(), 5);
}

#[test]
fn creates_gets_modifies_and_preserves_unknown_assistants() {
    let root = tempdir().unwrap();
    let thread = create_thread(root.path(), test_thread("Assistants")).unwrap();
    let thread_id = thread["id"].as_str().unwrap();
    let assistant = json!({"id": "assistant-1", "name": "Original"});

    create_thread_assistant(root.path(), thread_id, assistant.clone()).unwrap();
    assert_eq!(
        get_thread_assistant(root.path(), thread_id).unwrap(),
        assistant
    );

    let modified = json!({"id": "assistant-1", "name": "Modified"});
    modify_thread_assistant(root.path(), thread_id, modified.clone()).unwrap();
    assert_eq!(
        get_thread_assistant(root.path(), thread_id).unwrap(),
        modified
    );

    let unknown = json!({"id": "missing", "name": "Unknown"});
    assert_eq!(
        modify_thread_assistant(root.path(), thread_id, unknown.clone()).unwrap(),
        unknown
    );
    assert_eq!(
        get_thread_assistant(root.path(), thread_id).unwrap(),
        modified
    );
}

#[test]
fn reports_assistant_errors() {
    let root = tempdir().unwrap();
    let assistant = json!({"id": "assistant-1"});

    assert_eq!(
        get_thread_assistant(root.path(), "missing"),
        Err("Thread not found".to_string())
    );
    assert_eq!(
        create_thread_assistant(root.path(), "missing", assistant.clone()),
        Err("Thread not found".to_string())
    );
    assert_eq!(
        modify_thread_assistant(root.path(), "missing", assistant),
        Err("Thread not found".to_string())
    );
}

#[test]
fn returns_empty_collections_for_new_storage() {
    let root = tempdir().unwrap();
    assert!(list_threads(root.path()).unwrap().is_empty());
    assert!(list_messages(root.path(), "missing").unwrap().is_empty());
}

#[test]
fn detects_the_platform_storage_backend() {
    assert_eq!(
        should_use_sqlite(),
        cfg!(any(target_os = "android", target_os = "ios"))
    );
}

#[test]
fn writes_thread_metadata_to_the_expected_path() {
    let root = tempdir().unwrap();
    let thread = create_thread(root.path(), test_thread("Path")).unwrap();
    let thread_id = thread["id"].as_str().unwrap();
    assert!(get_thread_metadata_path(root.path(), thread_id).exists());
}
