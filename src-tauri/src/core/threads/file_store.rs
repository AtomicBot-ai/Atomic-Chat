use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use uuid::Uuid;

use super::constants::THREADS_FILE;
use super::helpers::{
    get_lock_for_thread, read_messages_from_file, update_thread_metadata, write_messages_to_file,
};
use super::utils::{
    ensure_data_dirs, ensure_thread_dir_exists, get_data_dir, get_messages_path, get_thread_dir,
    get_thread_metadata_path,
};

pub fn list_threads(data_folder: &Path) -> Result<Vec<serde_json::Value>, String> {
    ensure_data_dirs(data_folder)?;
    let data_dir = get_data_dir(data_folder);
    let mut threads = Vec::new();

    if !data_dir.exists() {
        return Ok(threads);
    }

    for entry in fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            let thread_metadata_path = path.join(THREADS_FILE);
            if thread_metadata_path.exists() {
                let data = fs::read_to_string(&thread_metadata_path).map_err(|e| e.to_string())?;
                match serde_json::from_str(&data) {
                    Ok(thread) => threads.push(thread),
                    Err(e) => {
                        println!("Failed to parse thread file: {e}");
                        continue;
                    }
                }
            }
        }
    }

    Ok(threads)
}

pub fn create_thread(
    data_folder: &Path,
    mut thread: serde_json::Value,
) -> Result<serde_json::Value, String> {
    ensure_data_dirs(data_folder)?;
    let uuid = Uuid::new_v4().to_string();
    thread["id"] = serde_json::Value::String(uuid.clone());
    let thread_dir = get_thread_dir(data_folder, &uuid);
    if !thread_dir.exists() {
        fs::create_dir_all(&thread_dir).map_err(|e| e.to_string())?;
    }
    let path = get_thread_metadata_path(data_folder, &uuid);
    let data = serde_json::to_string_pretty(&thread).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())?;
    Ok(thread)
}

pub fn modify_thread(data_folder: &Path, thread: serde_json::Value) -> Result<(), String> {
    let thread_id = thread
        .get("id")
        .and_then(|id| id.as_str())
        .ok_or("Missing thread id")?;
    let thread_dir = get_thread_dir(data_folder, thread_id);
    if !thread_dir.exists() {
        return Err("Thread directory does not exist".to_string());
    }
    let path = get_thread_metadata_path(data_folder, thread_id);
    let data = serde_json::to_string_pretty(&thread).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_thread(data_folder: &Path, thread_id: &str) -> Result<(), String> {
    let thread_dir = get_thread_dir(data_folder, thread_id);
    if thread_dir.exists() {
        let _ = fs::remove_dir_all(thread_dir);
    }
    Ok(())
}

pub fn list_messages(
    data_folder: &Path,
    thread_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    read_messages_from_file(data_folder, thread_id)
}

pub async fn create_message(
    data_folder: &Path,
    mut message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let thread_id = message
        .get("thread_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing thread_id")?
        .to_string();
    let path = get_messages_path(data_folder, &thread_id);

    if message.get("id").is_none() {
        let uuid = Uuid::new_v4().to_string();
        message["id"] = serde_json::Value::String(uuid);
    }

    {
        let lock = get_lock_for_thread(&thread_id).await;
        let _guard = lock.lock().await;
        ensure_thread_dir_exists(data_folder, &thread_id)?;

        let mut file: File = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;

        let data = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        writeln!(file, "{data}").map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
    }

    Ok(message)
}

pub async fn modify_message(
    data_folder: &Path,
    message: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let thread_id = message
        .get("thread_id")
        .and_then(|v| v.as_str())
        .ok_or("Missing thread_id")?;
    let message_id = message
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing message id")?;

    {
        let lock = get_lock_for_thread(thread_id).await;
        let _guard = lock.lock().await;

        let mut messages = read_messages_from_file(data_folder, thread_id)?;
        if let Some(index) = messages
            .iter()
            .position(|m| m.get("id").and_then(|v| v.as_str()) == Some(message_id))
        {
            messages[index] = message.clone();
            let path = get_messages_path(data_folder, thread_id);
            write_messages_to_file(&messages, &path)?;
        }
    }
    Ok(message)
}

pub async fn delete_message(
    data_folder: &Path,
    thread_id: &str,
    message_id: &str,
) -> Result<(), String> {
    {
        let lock = get_lock_for_thread(thread_id).await;
        let _guard = lock.lock().await;

        let mut messages = read_messages_from_file(data_folder, thread_id)?;
        messages.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(message_id));

        let path = get_messages_path(data_folder, thread_id);
        write_messages_to_file(&messages, &path)?;
    }

    Ok(())
}

pub fn get_thread_assistant(
    data_folder: &Path,
    thread_id: &str,
) -> Result<serde_json::Value, String> {
    let path = get_thread_metadata_path(data_folder, thread_id);
    if !path.exists() {
        return Err("Thread not found".to_string());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let thread: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    if let Some(assistants) = thread.get("assistants").and_then(|a| a.as_array()) {
        if let Some(first) = assistants.first() {
            Ok(first.clone())
        } else {
            Err("Assistant not found".to_string())
        }
    } else {
        Err("Assistant not found".to_string())
    }
}

pub fn create_thread_assistant(
    data_folder: &Path,
    thread_id: &str,
    assistant: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = get_thread_metadata_path(data_folder, thread_id);
    if !path.exists() {
        return Err("Thread not found".to_string());
    }
    let mut thread: serde_json::Value = {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())?
    };
    if let Some(assistants) = thread.get_mut("assistants").and_then(|a| a.as_array_mut()) {
        assistants.push(assistant.clone());
    } else {
        thread["assistants"] = serde_json::Value::Array(vec![assistant.clone()]);
    }
    update_thread_metadata(data_folder, thread_id, &thread)?;
    Ok(assistant)
}

pub fn modify_thread_assistant(
    data_folder: &Path,
    thread_id: &str,
    assistant: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let path = get_thread_metadata_path(data_folder, thread_id);
    if !path.exists() {
        return Err("Thread not found".to_string());
    }
    let mut thread: serde_json::Value = {
        let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&data).map_err(|e| e.to_string())?
    };
    let assistant_id = assistant
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing id")?;
    if let Some(assistants) = thread
        .get_mut("assistants")
        .and_then(|a: &mut serde_json::Value| a.as_array_mut())
    {
        if let Some(index) = assistants
            .iter()
            .position(|a| a.get("id").and_then(|v| v.as_str()) == Some(assistant_id))
        {
            assistants[index] = assistant.clone();
            update_thread_metadata(data_folder, thread_id, &thread)?;
        }
    }
    Ok(assistant)
}
