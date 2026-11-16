//! Desktop-owned acquisition of immutable Strata sources.
use super::{
    commands::AtomicCoreClient,
    fastflowlm_models::{owned, read_document, write_document},
    host_step::{claim, is_claimed},
};
use crate::core::downloads::{
    commands::download_files,
    disk::{ensure_free_space, rename_retrying},
    models::{DownloadItem, DownloadTask, HuggingFaceAuthorization, ProxyConfig},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing Strata {key}."))
}

fn safe_path(path: &str) -> bool {
    path.split('/').all(|part| {
        part.as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            && !part.ends_with('.')
            && !matches!(
                part.split('.')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "con"
                    | "prn"
                    | "aux"
                    | "nul"
                    | "com1"
                    | "com2"
                    | "com3"
                    | "com4"
                    | "com5"
                    | "com6"
                    | "com7"
                    | "com8"
                    | "com9"
                    | "lpt1"
                    | "lpt2"
                    | "lpt3"
                    | "lpt4"
                    | "lpt5"
                    | "lpt6"
                    | "lpt7"
                    | "lpt8"
                    | "lpt9"
            )
    })
}

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn task(id: &str) -> String {
    format!("strata-model-{}", id.replace('.', ":d"))
}

fn key(id: &str) -> String {
    format!("strata-mutation:{id}")
}

fn validate_model_id(id: &str) -> Result<(), String> {
    if id.len() > 128
        || id.contains('/')
        || !safe_path(id)
        || id.bytes().any(|b| b.is_ascii_uppercase())
    {
        return Err("Invalid Strata model ID.".into());
    }
    Ok(())
}

fn root(client: &AtomicCoreClient) -> Result<PathBuf, String> {
    let path = client
        .supervisor()
        .data_folder()
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join("strata");
    owned(&path)?;
    Ok(path)
}

async fn call(client: &AtomicCoreClient, path: &str, body: Value) -> Result<Value, String> {
    client
        .call("POST", path, Some(body))
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))
}

fn plan_items(plan: &Value, stage: &Path, id: &str) -> Result<Vec<DownloadItem>, String> {
    let d = &plan["descriptor"];
    let sources = d["sources"].as_array().ok_or("Missing Strata sources.")?;
    let files = d["files"]
        .as_array()
        .filter(|files| !files.is_empty())
        .ok_or("Missing Strata files.")?;
    let mut paths = HashSet::new();
    let mut total = 0u64;
    let mut items = Vec::with_capacity(files.len());
    for file in files {
        let path = field(file, "path")?;
        let remote = field(file, "source_path")?;
        let source_id = field(file, "source")?;
        let source = sources
            .iter()
            .find(|s| s["id"] == source_id)
            .ok_or("Unknown Strata source.")?;
        let revision = field(source, "revision")?;
        let repo = field(source, "repo")?;
        let sha = field(file, "sha256")?;
        let size = file["size"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("Invalid Strata file size.")?;
        let normalized = path.to_ascii_lowercase();
        if !safe_path(path)
            || !safe_path(remote)
            || normalized.split('/').next() == Some("model.yml")
            || !safe_path(repo)
            || repo.split('/').count() != 2
            || !hex(revision, 40)
            || !hex(sha, 64)
            || !paths.insert(normalized)
        {
            return Err("Invalid or duplicate Strata file source or path.".into());
        }
        total = total
            .checked_add(size)
            .ok_or("Strata source size overflow.")?;
        let url = match field(source, "host")? {
            "huggingface" => format!("https://huggingface.co/{repo}/resolve/{revision}/{remote}"),
            "github" => format!("https://raw.githubusercontent.com/{repo}/{revision}/{remote}"),
            _ => return Err("Unsupported Strata source host.".into()),
        };
        let save_path = stage.join(path);
        owned(&save_path)?;
        items.push(DownloadItem {
            url,
            save_path: save_path.to_string_lossy().into_owned(),
            proxy: None,
            sha256: Some(sha.into()),
            size: Some(size),
            model_id: Some(task(id)),
            resume_key: None,
            hf_authorization: None,
        });
    }
    if d["requirements"]["download_bytes"].as_u64() != Some(total) {
        return Err("Invalid Strata total size.".into());
    }
    Ok(items)
}

fn validate_plan(plan: &Value, id: &str) -> Result<(), String> {
    let digest = field(plan, "source_digest")?;
    let descriptor = &plan["descriptor"];
    let uuid = field(plan, "request_id")?;
    let mut canonical = descriptor.clone();
    canonical.sort_all_objects();
    if !plan.as_object().is_some_and(|p| p.len() == 3)
        || descriptor["variant_id"] != id
        || uuid::Uuid::parse_str(uuid).is_err()
        || !hex(digest, 64)
        || format!("{:x}", Sha256::digest(canonical.to_string())) != digest
    {
        return Err("Invalid Strata acquisition plan.".into());
    }
    Ok(())
}

async fn move_directory(from: &Path, to: &Path) -> Result<(), String> {
    owned(from)?;
    owned(to)?;
    if to.exists() {
        return Err("A Strata destination directory already exists.".into());
    }
    tokio::fs::create_dir_all(to.parent().ok_or("Missing Strata destination parent.")?)
        .await
        .map_err(|e| e.to_string())?;
    rename_retrying(from, to).await.map_err(|e| e.to_string())
}

async fn begin_guard(
    client: &AtomicCoreClient,
    id: &str,
    request: &str,
    action: &str,
    digest: Option<&Value>,
) -> Result<String, String> {
    let mut body = json!({ "model_id": id, "request_id": request, "action": action });
    if let Some(digest) = digest {
        body["target_source_digest"] = digest.clone();
    }
    let guard = call(client, "/models/strata/maintenance", body).await?;
    if guard["state"] == "completed" || guard["ready_to_mutate"] == true {
        Ok(field(&guard, "operation_id")?.into())
    } else {
        Err("Strata has not confirmed the model stopped.".into())
    }
}

async fn complete_guard(client: &AtomicCoreClient, id: &str) -> Result<(), String> {
    let result = call(
        client,
        &format!("/models/strata/maintenance/{id}/complete"),
        json!({}),
    )
    .await?;
    if result["state"] != "completed" {
        return Err("Strata maintenance is still active.".into());
    }
    Ok(())
}

async fn copy_import(
    source: &Path,
    stage: &Path,
    provider_root: &Path,
    items: &[DownloadItem],
    cancel: &CancellationToken,
    report: impl Fn(u64),
) -> Result<(), String> {
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    if source.starts_with(provider_root) {
        return Err(
            "Choose a Strata source directory outside the managed Strata data area.".into(),
        );
    }
    let mut total = 0u64;
    let mut completed = 0u64;
    let mut copies = Vec::new();
    for item in items {
        let target = Path::new(&item.save_path);
        let input = source.join(target.strip_prefix(stage).map_err(|e| e.to_string())?);
        owned(&input)?;
        let matches = |path: &Path| {
            path.metadata()
                .map(|m| m.is_file() && Some(m.len()) == item.size)
                .unwrap_or(false)
        };
        if !matches(&input) {
            return Err(format!(
                "Missing or incomplete Strata input: {}",
                input.display()
            ));
        }
        let sha = item
            .sha256
            .as_deref()
            .ok_or("Missing Strata source hash.")?;
        let name = target
            .file_name()
            .ok_or("Missing Strata input file name.")?;
        let staged = target.with_file_name(format!(".atomic-import-{}", name.to_string_lossy()));
        owned(&staged)?;
        // A terminated copy can leave its temporary file. Only a complete
        // file at the pinned path is eligible for reuse.
        match tokio::fs::remove_file(&staged).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        if matches(target)
            && jan_utils::crypto::compute_file_sha256_with_cancellation(target, cancel)
                .await
                .ok()
                .as_deref()
                == Some(sha)
        {
            completed += item.size.unwrap_or_default();
            continue;
        }
        total = total
            .checked_add(item.size.unwrap_or_default())
            .ok_or("Strata import size overflow.")?;
        copies.push((input, target, staged, sha));
    }
    ensure_free_space(stage, total)?;
    report(completed);
    let mut bytes = vec![0u8; 1024 * 1024];
    for (input, target, temp, sha) in copies {
        owned(target)?;
        let parent = target.parent().ok_or("Missing Strata file parent.")?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
        let transfer = async {
            let mut from = tokio::fs::File::open(input)
                .await
                .map_err(|e| e.to_string())?;
            let mut into = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)
                .await
                .map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut copied = 0u64;
            let mut last_report = tokio::time::Instant::now();
            loop {
                let read = from.read(&mut bytes).await.map_err(|e| e.to_string())?;
                if read == 0 {
                    break;
                }
                into.write_all(&bytes[..read])
                    .await
                    .map_err(|e| e.to_string())?;
                hasher.update(&bytes[..read]);
                copied += read as u64;
                if last_report.elapsed().as_millis() >= 250 {
                    report(completed + copied);
                    last_report = tokio::time::Instant::now();
                }
            }
            into.sync_all().await.map_err(|e| e.to_string())?;
            drop(into);
            let actual = format!("{:x}", hasher.finalize());
            if actual != sha {
                return Err("The Strata import does not match the pinned SHA-256.".into());
            }
            rename_retrying(&temp, target)
                .await
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(copied)
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err("Strata import cancelled.".into()),
            result = transfer => result,
        };
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        completed += result?;
        report(completed);
    }
    Ok(())
}

#[tauri::command]
pub async fn atomic_strata_acquire<R: Runtime>(
    app: AppHandle<R>,
    client: State<'_, AtomicCoreClient>,
    model_id: String,
    plan: Option<Value>,
    token: Option<String>,
    proxy: Option<ProxyConfig>,
    import_folder: Option<String>,
) -> Result<Value, String> {
    validate_model_id(&model_id)?;
    let _claim =
        claim(&key(&model_id)).ok_or("This Strata model already has an active operation.")?;
    let root = root(&client)?;
    let directory = root.join("transfers").join(&model_id);
    if read_document(&directory.join("remove.json"))
        .await?
        .is_some()
    {
        return Err("Finish the pending Strata removal first.".into());
    }
    let journal = directory.join("job.json");
    let installed = root.join("models").join(&model_id);
    owned(&installed)?;
    let saved = read_document(&journal).await?;
    let mut job = match saved {
        Some(job) if job["state"] != "ready" => job,
        _ => {
            if installed.exists() && read_document(&journal).await?.is_none() {
                return Err(
                    "An existing Strata folder is outside this installer's journal.".into(),
                );
            }
            let plan = plan.ok_or("The original Strata plan could not be found.")?;
            validate_plan(&plan, &model_id)?;
            plan_items(&plan, &directory.join("incoming"), &model_id)?;
            let check = call(
                &client,
                "/models/strata/check",
                json!({ "descriptor": plan["descriptor"] }),
            )
            .await?;
            if check["verdict"] != "ok" {
                return Err(check["reason"]
                    .as_str()
                    .unwrap_or("Strata preflight failed.")
                    .into());
            }
            let marker = read_document(&installed.join("model.yml")).await?;
            let state = if marker.as_ref().is_some_and(|m| {
                m["strata"]["source_digest"] == plan["source_digest"] && installed.is_dir()
            }) {
                "files-ready"
            } else {
                "acquiring"
            };
            let job = json!({ "model_id": model_id, "plan": plan, "state": state, "import_folder": import_folder });
            write_document(&journal, &job).await?;
            job
        }
    };
    let plan = job["plan"].clone();
    validate_plan(&plan, &model_id)?;
    let stage = directory.join("incoming");
    let previous = directory.join("previous");
    let request = field(&plan, "request_id")?;

    if job["state"] == "acquiring" {
        let mut items = plan_items(&plan, &stage, &model_id)?;
        if let Some(folder) = job["import_folder"].as_str() {
            let state = app.state::<crate::core::state::AppState>();
            let task_id = task(&model_id);
            let transfer = DownloadTask::new();
            if let Some(previous) = state
                .download_manager
                .lock()
                .await
                .cancel_tokens
                .insert(task_id.clone(), transfer.clone())
            {
                previous.supersede();
            }
            let result = copy_import(
                Path::new(folder),
                &stage,
                &root,
                &items,
                &transfer.cancel_token,
                |transferred| {
                    let _ = app.emit(
                        &format!("download-{task_id}"),
                        json!({
                            "transferred": transferred,
                            "total": plan["descriptor"]["requirements"]["download_bytes"],
                        }),
                    );
                },
            )
            .await;
            let mut manager = state.download_manager.lock().await;
            if manager
                .cancel_tokens
                .get(&task_id)
                .is_some_and(|running| running.is_same_task(&transfer))
            {
                manager.cancel_tokens.remove(&task_id);
            }
            result?;
        } else {
            for item in &mut items {
                item.proxy = proxy.clone();
                if item.url.starts_with("https://huggingface.co/") {
                    item.hf_authorization = token
                        .as_ref()
                        .filter(|t| !t.is_empty())
                        .map(|t| HuggingFaceAuthorization(format!("Bearer {t}")));
                }
            }
            download_files(
                app.clone(),
                app.state(),
                items,
                &task(&model_id),
                HashMap::new(),
                true,
            )
            .await?;
        }
        let d = &plan["descriptor"];
        let weight = d["inputs"]["weights"][0]
            .as_str()
            .ok_or("Missing Strata first weight.")?;
        write_document(&stage.join("model.yml"), &json!({
            "name": d["name"], "size_bytes": d["requirements"]["download_bytes"], "model_path": format!("strata/models/{model_id}/{weight}"),
            "strata": { "schema_version": 1, "source_digest": plan["source_digest"], "descriptor": d }
        })).await?;
        job["state"] = json!("publishing");
        write_document(&journal, &job).await?;
    }

    if job["state"] == "publishing" {
        let active = read_document(&installed.join("model.yml")).await?;
        let active_digest = active
            .as_ref()
            .and_then(|value| value["strata"]["source_digest"].as_str());
        if active_digest != plan["source_digest"].as_str() {
            if installed.exists() {
                if active_digest.is_none() {
                    return Err("The existing Strata folder is not an app installation.".into());
                }
                let guard = begin_guard(
                    &client,
                    &model_id,
                    &format!("{request}:replace"),
                    "replace",
                    Some(&plan["source_digest"]),
                )
                .await?;
                job["maintenance_id"] = json!(guard);
                write_document(&journal, &job).await?;
                move_directory(&installed, &previous).await?;
            }
            move_directory(&stage, &installed).await?;
        } else if stage.is_dir() {
            owned(&stage)?;
            tokio::fs::remove_dir_all(&stage)
                .await
                .map_err(|e| e.to_string())?;
        }
        job["state"] = json!("files-ready");
        write_document(&journal, &job).await?;
    }
    Ok(job)
}

#[tauri::command]
pub async fn atomic_strata_jobs(client: State<'_, AtomicCoreClient>) -> Result<Vec<Value>, String> {
    let transfers = root(&client)?.join("transfers");
    owned(&transfers)?;
    let mut rows = match tokio::fs::read_dir(transfers).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut jobs = Vec::new();
    while let Some(entry) = rows.next_entry().await.map_err(|e| e.to_string())? {
        if !entry.file_type().await.map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        if let Some(mut job) = read_document(&entry.path().join("job.json")).await? {
            job["running"] = json!(is_claimed(&key(field(&job, "model_id")?)));
            job["removing"] = json!(read_document(&entry.path().join("remove.json"))
                .await?
                .is_some());
            jobs.push(job);
        }
    }
    Ok(jobs)
}

#[tauri::command]
pub async fn atomic_strata_finish_install<R: Runtime>(
    app: AppHandle<R>,
    client: State<'_, AtomicCoreClient>,
    model_id: String,
) -> Result<(), String> {
    validate_model_id(&model_id)?;
    let _claim =
        claim(&key(&model_id)).ok_or("This Strata model already has an active operation.")?;
    let directory = root(&client)?.join("transfers").join(&model_id);
    let journal = directory.join("job.json");
    let mut job = read_document(&journal)
        .await?
        .ok_or("Missing Strata install job.")?;
    if job["state"] == "ready" {
        return Ok(());
    }
    if job["state"] != "files-ready" {
        return Err("Strata sources are not installed yet.".into());
    }
    if let Some(guard) = job["maintenance_id"].as_str() {
        complete_guard(&client, guard).await?;
        let previous = directory.join("previous");
        owned(&previous)?;
        if previous.exists() {
            tokio::fs::remove_dir_all(previous)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    let check = call(
        &client,
        "/models/strata/check",
        json!({ "model_id": model_id }),
    )
    .await?;
    if check["preparation_status"] != "ready" || check["verdict"] != "ok" {
        return Err(check["reason"]
            .as_str()
            .unwrap_or("Strata preparation is not ready.")
            .into());
    }
    let catalog = call(&client, "/engine-builds/strata/catalog", json!({})).await?;
    job["state"] = json!("ready");
    job["prepared_build"] = catalog["active"].clone();
    job["capabilities"] = check["capabilities"].clone();
    write_document(&journal, &job).await?;
    let _ = app.emit("atomic-strata-models-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn atomic_strata_remove_model<R: Runtime>(
    app: AppHandle<R>,
    client: State<'_, AtomicCoreClient>,
    model_id: String,
) -> Result<(), String> {
    validate_model_id(&model_id)?;
    let _claim =
        claim(&key(&model_id)).ok_or("This Strata model already has an active operation.")?;
    let root = root(&client)?;
    let transfer = root.join("transfers").join(&model_id);
    let journal = transfer.join("remove.json");
    let target = root.join("models").join(&model_id);
    owned(&target)?;
    let removed = transfer.join("removed");
    let request = match read_document(&journal).await? {
        Some(request) => request,
        None => {
            let job = read_document(&transfer.join("job.json"))
                .await?
                .ok_or("Strata model is not an app installation.")?;
            if job["state"] != "ready" {
                return Err("Finish the pending Strata installation first.".into());
            }
            let request = json!({ "request_id": uuid::Uuid::new_v4().to_string() });
            write_document(&journal, &request).await?;
            request
        }
    };
    let guard = begin_guard(
        &client,
        &model_id,
        field(&request, "request_id")?,
        "remove",
        None,
    )
    .await?;
    if target.exists() {
        move_directory(&target, &removed).await?;
    }
    complete_guard(&client, &guard).await?;
    owned(&transfer)?;
    tokio::fs::remove_dir_all(transfer)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("atomic-strata-models-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(path: &str) -> Value {
        json!({ "descriptor": {
            "sources": [{ "id": "hf", "host": "huggingface", "repo": "owner/repo", "revision": "a".repeat(40) }],
            "files": [{ "path": path, "source_path": "model.gguf", "source": "hf", "size": 3, "sha256": "b".repeat(64) }],
            "requirements": { "download_bytes": 3 }
        }})
    }

    #[test]
    fn strata_plan_pins_revision_hash_and_destination() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let items = plan_items(&plan("weights/model.gguf"), &root, "strata-model").unwrap();
        assert_eq!(items[0].size, Some(3));
        assert_eq!(items[0].sha256, Some("b".repeat(64)));
        assert_eq!(
            items[0].url,
            format!(
                "https://huggingface.co/owner/repo/resolve/{}/model.gguf",
                "a".repeat(40)
            )
        );
        assert_eq!(
            Path::new(&items[0].save_path),
            root.join("weights/model.gguf")
        );
        assert!(items[0].hf_authorization.is_none());
    }

    #[test]
    fn strata_plan_refuses_path_aliases_and_missing_hash() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        for path in ["../model", "model.yml/weights", "NUL.gguf", "a/../model"] {
            assert!(plan_items(&plan(path), &root, "strata-model").is_err());
        }
        let mut invalid = plan("model.gguf");
        invalid["descriptor"]["files"][0]["sha256"] = json!("");
        assert!(plan_items(&invalid, &root, "strata-model").is_err());
    }

    #[tokio::test]
    async fn strata_import_rejects_a_bad_hash_and_preserves_original() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let stage = root.join("managed/incoming");
        let source = root.join("import");
        tokio::fs::create_dir(&source).await.unwrap();
        tokio::fs::write(source.join("model.gguf"), "abc")
            .await
            .unwrap();
        let mut pinned = plan("model.gguf");
        let items = plan_items(&pinned, &stage, "strata-model").unwrap();
        assert!(copy_import(
            &source,
            &stage,
            &root.join("managed"),
            &items,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .is_err());
        assert_eq!(
            tokio::fs::read(source.join("model.gguf")).await.unwrap(),
            b"abc"
        );
        assert!(!stage.join("model.gguf").exists());
        pinned["descriptor"]["files"][0]["sha256"] = json!(format!("{:x}", Sha256::digest(b"abc")));
        let items = plan_items(&pinned, &stage, "strata-model").unwrap();
        tokio::fs::write(stage.join(".atomic-import-model.gguf"), b"ab")
            .await
            .unwrap();

        copy_import(
            &source,
            &stage,
            &root.join("managed"),
            &items,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
        copy_import(
            &source,
            &stage,
            &root.join("managed"),
            &items,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
        assert!(!stage.join(".atomic-import-model.gguf").exists());
        assert_eq!(
            tokio::fs::read(stage.join("model.gguf")).await.unwrap(),
            b"abc"
        );
    }
}
