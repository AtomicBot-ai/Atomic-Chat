//! Durable desktop-owned FastFlowLM transfers and publication; core only checks and guards models.
use super::commands::AtomicCoreClient;
use crate::core::downloads::{
    commands::download_files,
    disk::rename_retrying,
    models::{DownloadItem, HuggingFaceAuthorization, ProxyConfig},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing FastFlowLM {key}."))
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && relative(value)
}
fn relative(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-/".contains(&c))
        && value.split('/').all(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && !s.ends_with('.')
                && !matches!(
                    s.split('.')
                        .next()
                        .unwrap_or("")
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
fn plan_items(plan: &Value, stage: &Path, task: &str) -> Result<Vec<DownloadItem>, String> {
    let descriptor = &plan["descriptor"];
    let files = descriptor["files"]
        .as_array()
        .ok_or("Missing FastFlowLM file plan.")?;
    let sources = descriptor["sources"]
        .as_array()
        .ok_or("Missing FastFlowLM sources.")?;
    let mut paths = HashSet::new();
    files
        .iter()
        .map(|file| {
            let path = text(file, "path")?;
            let source_path = text(file, "source_path")?;
            if !relative(path)
                || !relative(source_path)
                || matches!(
                    path.split('/')
                        .next()
                        .unwrap_or("")
                        .to_ascii_lowercase()
                        .as_str(),
                    "model.yml" | "flm"
                )
                || !paths.insert(path.to_ascii_lowercase())
            {
                return Err("Invalid or duplicate FastFlowLM file path.".into());
            }
            let source_id = text(file, "source")?;
            let source = sources
                .iter()
                .find(|s| s["id"].as_str() == Some(source_id))
                .ok_or("Unknown FastFlowLM source.")?;
            let revision = text(source, "revision")?;
            let repo = text(source, "repo")?;
            let sha = text(file, "sha256")?;
            let size = file["size"]
                .as_u64()
                .filter(|s| *s > 0)
                .ok_or("Missing FastFlowLM file size.")?;
            if !hex(revision, 40)
                || !hex(sha, 64)
                || !relative(repo)
                || repo.split('/').count() != 2
            {
                return Err(
                    "FastFlowLM requires immutable sources and SHA-256 for every file.".into(),
                );
            }
            let url = match source.get("host").and_then(Value::as_str) {
                None | Some("huggingface") => {
                    format!("https://huggingface.co/{repo}/resolve/{revision}/{source_path}")
                }
                Some("github") => {
                    format!("https://raw.githubusercontent.com/{repo}/{revision}/{source_path}")
                }
                _ => return Err("Unsupported FastFlowLM source host.".into()),
            };
            Ok(DownloadItem {
                url,
                save_path: stage.join(path).to_string_lossy().into_owned(),
                proxy: None,
                sha256: Some(sha.into()),
                size: Some(size),
                model_id: Some(task.into()),
                resume_key: None,
                hf_authorization: None,
            })
        })
        .collect()
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&map[key])))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}
fn validate_plan(plan: &Value, id: &str) -> Result<(), String> {
    if plan["schema_version"] != 1
        || !identifier(id)
        || plan["descriptor"]["variant_id"].as_str() != Some(id)
        || !identifier(text(plan, "request_id")?)
    {
        return Err("Invalid FastFlowLM install identity.".into());
    }
    let allowed = [
        "model_id",
        "variant_id",
        "checkpoint",
        "minimum_flm_version",
        "local_only_protocol",
        "npu_generation",
        "context_length",
        "capabilities",
        "sources",
        "files",
    ];
    if plan["descriptor"]
        .as_object()
        .ok_or("Invalid descriptor.")?
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
    {
        return Err("Unexpected FastFlowLM descriptor field.".into());
    }
    let digest = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&canonical(&plan["descriptor"])).map_err(|e| e.to_string())?
        )
    );
    if text(plan, "digest")? != digest {
        return Err("FastFlowLM install plan digest changed.".into());
    }
    let items = plan_items(plan, Path::new("stage"), "task")?;
    if items.is_empty()
        || Some(
            items
                .iter()
                .map(|i| i.size.unwrap_or(0))
                .try_fold(0u64, |sum, n| sum.checked_add(n))
                .ok_or("FastFlowLM size overflow.")?,
        ) != plan["total_bytes"].as_u64()
    {
        return Err("Invalid FastFlowLM total size.".into());
    }
    Ok(())
}
pub(super) fn owned(path: &Path) -> Result<(), String> {
    let resolved = jan_utils::canonicalize_existing_prefix(path);
    if jan_utils::normalize_path(&resolved) != jan_utils::normalize_path(path) {
        return Err("Redirected FastFlowLM installer path.".into());
    }
    Ok(())
}
pub(super) async fn write_document(path: &Path, value: &Value) -> Result<(), String> {
    owned(path)?;
    let parent = path.parent().ok_or("Missing installer parent.")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".atomic-{}.new", uuid::Uuid::new_v4()));
    let mut f = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
        .map_err(|e| e.to_string())?;
    use tokio::io::AsyncWriteExt;
    f.write_all(value.to_string().as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    f.sync_all().await.map_err(|e| e.to_string())?;
    drop(f);
    rename_retrying(&temp, path)
        .await
        .map_err(|e| e.to_string())
}
pub(super) async fn read_document(path: &Path) -> Result<Option<Value>, String> {
    owned(path)?;
    match tokio::fs::read_to_string(path).await {
        Ok(s) if path.extension().and_then(|ext| ext.to_str()) == Some("yml") => {
            serde_yaml::from_str(&s)
                .map(Some)
                .map_err(|e| e.to_string())
        }
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
async fn remove_dir(path: &Path) -> Result<(), String> {
    owned(path)?;
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
async fn call(
    client: &AtomicCoreClient,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    client
        .call(method, path, body)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))
}
trait PublicationControl: Sync {
    fn request<'a>(
        &'a self,
        method: &'a str,
        path: &'a str,
        body: Option<Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>;
}
impl PublicationControl for AtomicCoreClient {
    fn request<'a>(
        &'a self,
        method: &'a str,
        path: &'a str,
        body: Option<Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(call(self, method, path, body))
    }
}
fn root(client: &AtomicCoreClient) -> Result<PathBuf, String> {
    let data = client
        .supervisor()
        .data_folder()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = data.join("fastflowlm");
    owned(&root)?;
    Ok(root)
}

fn install_finished(job: &Value) -> bool {
    job["state"] == "ready"
        || (job["state"] == "rolled-back" && job["maintenance_completed"] == true)
}
fn publication_pending(job: &Value) -> bool {
    !install_finished(job)
        && matches!(
            job["state"].as_str(),
            Some("publishing" | "accepted" | "rollback-pending" | "rolled-back")
        )
}

async fn publish(
    client: &impl PublicationControl,
    root: &Path,
    journal: &Path,
    job: &mut Value,
) -> Result<(), String> {
    // Older rolled-back journals did not record acknowledgement. Reconcile their original guard.
    if job["state"] == "rolled-back" && !install_finished(job) {
        job["state"] = json!("rollback-pending");
    }
    let id = text(job, "model_id")?.to_string();
    let plan = job["plan"].clone();
    validate_plan(&plan, &id)?;
    let stage = root.join("transfers").join(&id).join("model");
    let target = root.join("models").join(&id);
    let backup = root.join("transfers").join(&id).join("previous");
    for path in [&stage, &target, &backup] {
        owned(path)?;
    }
    let guard = client
        .request(
            "POST",
            "/models/fastflowlm/maintenance",
            Some(json!({"request_id":plan["request_id"],"model_id":id,"kind":"replace"})),
        )
        .await?;
    let operation = text(&guard, "operation_id")?;
    if guard["ready_to_mutate"] != true {
        let current = client
            .request(
                "GET",
                &format!("/models/fastflowlm/maintenance/{operation}"),
                None,
            )
            .await?;
        if current["state"] != "completed"
            || !matches!(job["state"].as_str(), Some("accepted" | "rollback-pending"))
        {
            return Err("FastFlowLM maintenance has not confirmed unload.".into());
        }
    } else {
        if job["state"] == "publishing" {
            let result = async {
                // Rename consumes this operation's staging directory. An older matching digest
                // alone must never bypass freshly verified replacement bytes.
                let promoted = !stage.exists()
                    && (job["had_previous"] == false || backup.exists())
                    && read_document(&target.join("model.yml"))
                        .await?
                        .is_some_and(|y| y["fastflowlm"]["catalog_digest"] == plan["digest"]);
                if !promoted {
                    if target.exists() {
                        if backup.exists() {
                            return Err("Both previous FastFlowLM folders require recovery.".into());
                        }
                        rename_retrying(&target, &backup)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                    tokio::fs::create_dir_all(target.parent().unwrap())
                        .await
                        .map_err(|e| e.to_string())?;
                    rename_retrying(&stage, &target)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                let checked = client
                    .request(
                        "POST",
                        "/models/fastflowlm/check",
                        Some(json!({"model_id":id})),
                    )
                    .await?;
                if checked["verdict"] != "ok" {
                    return Err(checked["reason"]
                        .as_str()
                        .unwrap_or("FastFlowLM installation failed validation.")
                        .to_string());
                }
                Ok::<(), String>(())
            }
            .await;
            match result {
                Ok(()) => job["state"] = json!("accepted"),
                Err(error) => {
                    if backup.exists() {
                        remove_dir(&target).await?;
                        rename_retrying(&backup, &target)
                            .await
                            .map_err(|e| e.to_string())?;
                    } else if job["had_previous"] == false {
                        remove_dir(&target).await?;
                    }
                    job["state"] = json!("rollback-pending");
                    job["error"] = json!(error);
                }
            }
            write_document(journal, job).await?;
        }
        client
            .request(
                "POST",
                &format!("/models/fastflowlm/maintenance/{operation}/complete"),
                Some(json!({})),
            )
            .await?;
    }
    remove_dir(&backup).await?;
    job["maintenance_completed"] = json!(true);
    if job["state"] == "rollback-pending" {
        job["state"] = json!("rolled-back");
        write_document(journal, job).await?;
        return Err(job["error"]
            .as_str()
            .unwrap_or("FastFlowLM install rolled back.")
            .into());
    }
    job["state"] = json!("ready");
    write_document(journal, job).await
}

#[tauri::command]
pub async fn atomic_fastflowlm_install_model<R: Runtime>(
    app: AppHandle<R>,
    client: State<'_, AtomicCoreClient>,
    model_id: String,
    plan: Value,
    headers: HashMap<String, String>,
    proxy: Option<ProxyConfig>,
) -> Result<Value, String> {
    if !identifier(&model_id) {
        return Err("Invalid FastFlowLM variant ID.".into());
    }
    let _claim = super::host_step::claim(&format!("fastflowlm-model:{model_id}"))
        .ok_or("This FastFlowLM model already has an operation running.")?;
    let root = root(&client)?;
    let directory = root.join("transfers").join(&model_id);
    owned(&directory)?;
    let journal = directory.join("job.json");
    if directory.join("remove.json").exists() {
        return Err("Finish the saved FastFlowLM removal before installing this variant.".into());
    }
    let saved = read_document(&journal).await?;
    let mut job = match saved {
        Some(job) if !install_finished(&job) => job,
        _ => {
            validate_plan(&plan, &model_id)?;
            json!({"model_id":model_id,"state":"downloading","plan":plan})
        }
    };
    let plan = job["plan"].clone();
    validate_plan(&plan, &model_id)?;
    // Persist before any transfer; headers and proxy credentials never enter this journal.
    write_document(&journal, &job).await?;
    if job["state"] == "downloading" {
        let check = call(
            &client,
            "POST",
            "/models/fastflowlm/check",
            Some(json!({"descriptor":plan["descriptor"]})),
        )
        .await?;
        if check["verdict"] != "ok" {
            return Err(check["reason"]
                .as_str()
                .unwrap_or("FastFlowLM is not ready.")
                .into());
        }
        let stage = directory.join("model");
        owned(&stage)?;
        let task = format!("fastflowlm-{}", model_id.replace('.', "_"));
        let mut items = plan_items(&plan, &stage, &task)?;
        for item in &mut items {
            owned(Path::new(&item.save_path))?;
            item.proxy = proxy.clone();
            item.hf_authorization = headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                .map(|(_, value)| HuggingFaceAuthorization(value.clone()));
        }
        download_files(app.clone(), app.state(), items, &task, HashMap::new(), true).await?;
        write_document(
            &stage.join("flm/model_list.json"),
            &plan["config"]["modelList"],
        )
        .await?;
        write_document(
            &stage.join("flm/model_info.json"),
            &plan["config"]["modelInfo"],
        )
        .await?;
        let mut marker = plan["descriptor"].clone();
        marker["schema_version"] = json!(1);
        marker["catalog_digest"] = plan["digest"].clone();
        marker["model_list_path"] = json!("flm/model_list.json");
        marker["model_info_path"] = json!("flm/model_info.json");
        write_document(&stage.join("model.yml"),&json!({"name":plan["name"],"model_path":format!("fastflowlm/models/{model_id}"),"size_bytes":plan["total_bytes"],"fastflowlm":marker})).await?;
        job["had_previous"] = json!(root.join("models").join(&model_id).exists());
        job["state"] = json!("publishing");
        write_document(&journal, &job).await?;
    }
    let result = publish(&*client, &root, &journal, &mut job).await;
    let _ = app.emit(
        "atomic-fastflowlm-models-changed",
        json!({"model_id":model_id}),
    );
    result?;
    Ok(job)
}

#[tauri::command]
pub async fn atomic_fastflowlm_install_jobs(
    client: State<'_, AtomicCoreClient>,
) -> Result<Vec<Value>, String> {
    let root = root(&client)?.join("transfers");
    owned(&root)?;
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut entries = tokio::fs::read_dir(root).await.map_err(|e| e.to_string())?;
    let mut jobs = vec![];
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        if !entry.file_type().await.map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        if let Some(mut job) = read_document(&entry.path().join("job.json")).await? {
            validate_plan(&job["plan"], text(&job, "model_id")?)?;
            job["running"] = json!(super::host_step::is_claimed(&format!(
                "fastflowlm-model:{}",
                text(&job, "model_id")?
            )));
            jobs.push(job);
        }
    }
    Ok(jobs)
}

#[tauri::command]
pub async fn atomic_fastflowlm_remove_model<R: Runtime>(
    app: AppHandle<R>,
    client: State<'_, AtomicCoreClient>,
    model_id: String,
) -> Result<Value, String> {
    if !identifier(&model_id) {
        return Err("Invalid FastFlowLM variant ID.".into());
    }
    let _claim = super::host_step::claim(&format!("fastflowlm-model:{model_id}"))
        .ok_or("This FastFlowLM model is being changed.")?;
    let root = root(&client)?;
    let directory = root.join("transfers").join(&model_id);
    owned(&directory)?;
    if let Some(job) = read_document(&directory.join("job.json")).await? {
        if !install_finished(&job) {
            return Err(
                "Finish or resume the FastFlowLM installation before deleting this variant.".into(),
            );
        }
    }
    let result = finish_removal(&*client, &root, &directory, &model_id).await?;
    let _ = app.emit(
        "atomic-fastflowlm-models-changed",
        json!({"model_id":model_id}),
    );
    Ok(result)
}

async fn finish_removal(
    client: &impl PublicationControl,
    root: &Path,
    directory: &Path,
    model_id: &str,
) -> Result<Value, String> {
    let intent = directory.join("remove.json");
    let target = root.join("models").join(model_id);
    let backup = directory.join("removed");
    for path in [&target, &backup] {
        owned(path)?;
    }
    let mut job = read_document(&intent).await?.unwrap_or(
        json!({"request_id":uuid::Uuid::new_v4().to_string(),"mutated":false,"freedBytes":0}),
    );
    if let Some(yml) = read_document(&target.join("model.yml")).await? {
        job["freedBytes"] = yml["size_bytes"].clone();
    }
    write_document(&intent, &job).await?;
    let guard = client
        .request(
            "POST",
            "/models/fastflowlm/maintenance",
            Some(json!({"request_id":job["request_id"],"model_id":model_id,"kind":"remove"})),
        )
        .await?;
    let operation = text(&guard, "operation_id")?;
    if guard["ready_to_mutate"] == true {
        if target.exists() {
            if backup.exists() {
                return Err("FastFlowLM removal needs recovery.".into());
            }
            rename_retrying(&target, &backup)
                .await
                .map_err(|e| e.to_string())?;
        }
        job["mutated"] = json!(true);
        write_document(&intent, &job).await?;
        client
            .request(
                "POST",
                &format!("/models/fastflowlm/maintenance/{operation}/complete"),
                Some(json!({})),
            )
            .await?;
    } else {
        let current = client
            .request(
                "GET",
                &format!("/models/fastflowlm/maintenance/{operation}"),
                None,
            )
            .await?;
        if current["state"] != "completed" || job["mutated"] != true {
            return Err("FastFlowLM removal is waiting for confirmed unload.".into());
        }
    }
    remove_dir(&backup).await?;
    tokio::fs::remove_file(&intent)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({"freedBytes":job["freedBytes"]}))
}

/// Recover only already persisted mutations. Downloads remain paused until the operator resumes them.
#[tauri::command]
pub async fn atomic_fastflowlm_recover_mutations<R: Runtime>(
    app: AppHandle<R>,
    client: State<'_, AtomicCoreClient>,
) -> Result<Vec<String>, String> {
    let root = root(&client)?;
    let transfers = root.join("transfers");
    owned(&transfers)?;
    if !transfers.exists() {
        return Ok(vec![]);
    }
    let mut entries = tokio::fs::read_dir(&transfers)
        .await
        .map_err(|e| e.to_string())?;
    let mut errors = vec![];
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !identifier(&id) || !entry.file_type().await.map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let Some(_claim) = super::host_step::claim(&format!("fastflowlm-model:{id}")) else {
            continue;
        };
        let directory = entry.path();
        let result = if directory.join("remove.json").exists() {
            finish_removal(&*client, &root, &directory, &id)
                .await
                .map(|_| ())
        } else if let Some(mut job) = read_document(&directory.join("job.json")).await? {
            if !publication_pending(&job) {
                continue;
            }
            let result = publish(&*client, &root, &directory.join("job.json"), &mut job).await;
            if result.is_err() && install_finished(&job) {
                let _ = app.emit("atomic-fastflowlm-models-changed", json!({"model_id":id}));
            }
            result
        } else {
            continue;
        };
        match result {
            Ok(()) => {
                let _ = app.emit("atomic-fastflowlm-models-changed", json!({"model_id":id}));
            }
            Err(e) => errors.push(format!("{id}: {e}")),
        }
    }
    Ok(errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn plan() -> Value {
        json!({"schema_version":1,"request_id":"install-1","name":"Qwen3","digest":"a".repeat(64),"total_bytes":5,
          "descriptor":{"variant_id":"qwen3-06b","sources":[{"id":"model","repo":"FastFlowLM/Qwen3","revision":"b".repeat(40)}],
            "files":[{"source":"model","source_path":"config.json","path":"config.json","size":5,"sha256":"c".repeat(64)}]},
          "config":{}})
    }
    #[test]
    fn fastflowlm_download_rejects_traversal_and_mutable_revisions() {
        let mut p = plan();
        p["descriptor"]["files"][0]["path"] = json!("../outside");
        assert!(plan_items(&p, Path::new("/data/stage"), "task").is_err());
        let mut p = plan();
        p["descriptor"]["sources"][0]["revision"] = json!("main");
        assert!(plan_items(&p, Path::new("/data/stage"), "task").is_err());
    }
    #[test]
    fn fastflowlm_download_requires_a_sha256_even_for_a_small_config() {
        let mut p = plan();
        p["descriptor"]["files"][0]
            .as_object_mut()
            .unwrap()
            .remove("sha256");
        assert!(plan_items(&p, Path::new("/data/stage"), "task").is_err());
    }
    #[test]
    fn fastflowlm_plan_digest_ignores_property_insertion_order() {
        let mut p = plan();
        let sorted = json!({"files":[{"path":"config.json","sha256":"c".repeat(64),"size":5,"source":"model","source_path":"config.json"}],"sources":[{"id":"model","repo":"FastFlowLM/Qwen3","revision":"b".repeat(40)}],"variant_id":"qwen3-06b"});
        p["digest"] = json!(format!(
            "{:x}",
            Sha256::digest(sorted.to_string().as_bytes())
        ));
        validate_plan(&p, "qwen3-06b").unwrap();
    }

    struct PublicationFake {
        valid: bool,
        completed: std::sync::atomic::AtomicBool,
        lose_completion: std::sync::atomic::AtomicBool,
    }
    impl PublicationControl for PublicationFake {
        fn request<'a>(
            &'a self,
            _method: &'a str,
            path: &'a str,
            _body: Option<Value>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
        {
            Box::pin(async move {
                use std::sync::atomic::Ordering::SeqCst;
                if path.ends_with("/check") {
                    return Ok(
                        json!({"verdict":if self.valid{"ok"}else{"invalid-installation"},"reason":"Invalid local config"}),
                    );
                }
                if path.ends_with("/complete") {
                    self.completed.store(true, SeqCst);
                    if self.lose_completion.swap(false, SeqCst) {
                        return Err("Completion response lost".into());
                    }
                    return Ok(json!({}));
                }
                if path.ends_with("/maintenance") {
                    return Ok(
                        json!({"operation_id":"guard-1","ready_to_mutate":!self.completed.load(SeqCst)}),
                    );
                }
                Ok(json!({"state":if self.completed.load(SeqCst){"completed"}else{"held"}}))
            })
        }
    }
    async fn publication_fixture() -> (tempfile::TempDir, PathBuf, PathBuf, Value) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("fastflowlm");
        let mut p = plan();
        p["digest"] = json!(format!(
            "{:x}",
            Sha256::digest(canonical(&p["descriptor"]).to_string().as_bytes())
        ));
        let id = "qwen3-06b";
        let stage = root.join("transfers").join(id).join("model");
        let target = root.join("models").join(id);
        write_document(
            &stage.join("model.yml"),
            &json!({"fastflowlm":{"catalog_digest":p["digest"]}}),
        )
        .await
        .unwrap();
        write_document(
            &target.join("model.yml"),
            &json!({"fastflowlm":{"catalog_digest":"previous"}}),
        )
        .await
        .unwrap();
        let journal = root.join("transfers").join(id).join("job.json");
        let job = json!({"model_id":id,"plan":p,"state":"publishing","had_previous":true});
        write_document(&journal, &job).await.unwrap();
        (temp, root, journal, job)
    }
    #[tokio::test]
    async fn fastflowlm_recovery_keeps_backup_until_completion_is_acknowledged() {
        let (_temp, root, journal, mut job) = publication_fixture().await;
        let core = PublicationFake {
            valid: true,
            completed: false.into(),
            lose_completion: true.into(),
        };
        assert!(publish(&core, &root, &journal, &mut job).await.is_err());
        let backup = root.join("transfers/qwen3-06b/previous/model.yml");
        assert!(backup.exists());
        let mut restarted = read_document(&journal).await.unwrap().unwrap();
        assert_eq!(restarted["state"], "accepted");
        publish(&core, &root, &journal, &mut restarted)
            .await
            .unwrap();
        assert_eq!(restarted["state"], "ready");
        assert!(!backup.exists());
    }
    #[tokio::test]
    async fn fastflowlm_recovery_rolls_back_a_refused_promoted_model() {
        let (_temp, root, journal, mut job) = publication_fixture().await;
        let core = PublicationFake {
            valid: false,
            completed: false.into(),
            lose_completion: false.into(),
        };
        assert!(publish(&core, &root, &journal, &mut job).await.is_err());
        let restored = read_document(&root.join("models/qwen3-06b/model.yml"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored["fastflowlm"]["catalog_digest"], "previous");
        assert_eq!(job["state"], "rolled-back");
        assert!(core.completed.load(std::sync::atomic::Ordering::SeqCst));
    }
    #[tokio::test]
    async fn fastflowlm_removal_recovers_a_lost_completion_response() {
        let (_temp, root, _journal, _job) = publication_fixture().await;
        let directory = root.join("transfers/qwen3-06b");
        let core = PublicationFake {
            valid: true,
            completed: false.into(),
            lose_completion: true.into(),
        };
        assert!(finish_removal(&core, &root, &directory, "qwen3-06b")
            .await
            .is_err());
        assert!(directory.join("removed").exists());
        assert!(directory.join("remove.json").exists());
        finish_removal(&core, &root, &directory, "qwen3-06b")
            .await
            .unwrap();
        assert!(!directory.join("removed").exists());
        assert!(!directory.join("remove.json").exists());
        assert!(!root.join("models/qwen3-06b").exists());
    }
    struct StoppingControl;
    impl PublicationControl for StoppingControl {
        fn request<'a>(
            &'a self,
            _method: &'a str,
            path: &'a str,
            _body: Option<Value>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
        {
            Box::pin(async move {
                Ok(if path.ends_with("/maintenance") {
                    json!({"operation_id":"guard-stopping","ready_to_mutate":false})
                } else {
                    json!({"state":"stopping"})
                })
            })
        }
    }
    #[tokio::test]
    async fn fastflowlm_waits_for_confirmed_unload_before_replacing_files() {
        let (_temp, root, journal, mut job) = publication_fixture().await;
        assert!(publish(&StoppingControl, &root, &journal, &mut job)
            .await
            .unwrap_err()
            .contains("unload"));
        assert_eq!(
            read_document(&root.join("models/qwen3-06b/model.yml"))
                .await
                .unwrap()
                .unwrap()["fastflowlm"]["catalog_digest"],
            "previous"
        );
        assert!(root.join("transfers/qwen3-06b/model/model.yml").exists());
        assert!(!root.join("transfers/qwen3-06b/previous").exists());
    }
    #[tokio::test]
    async fn fastflowlm_restart_after_promotion_reuses_the_original_guard() {
        let (_temp, root, journal, mut job) = publication_fixture().await;
        let directory = root.join("transfers/qwen3-06b");
        let target = root.join("models/qwen3-06b");
        tokio::fs::rename(&target, directory.join("previous"))
            .await
            .unwrap();
        tokio::fs::rename(directory.join("model"), &target)
            .await
            .unwrap();
        let core = PublicationFake {
            valid: true,
            completed: false.into(),
            lose_completion: false.into(),
        };
        publish(&core, &root, &journal, &mut job).await.unwrap();
        assert_eq!(job["state"], "ready");
        assert!(!directory.join("previous").exists());
        assert_eq!(
            read_document(&target.join("model.yml"))
                .await
                .unwrap()
                .unwrap()["fastflowlm"]["catalog_digest"],
            job["plan"]["digest"]
        );
    }
    #[tokio::test]
    async fn fastflowlm_yaml_marker_can_be_removed_through_the_guard() {
        let (_temp, root, _journal, _job) = publication_fixture().await;
        tokio::fs::write(
            root.join("models/qwen3-06b/model.yml"),
            "name: Qwen\nsize_bytes: 5\nfastflowlm:\n  variant_id: qwen3-06b\n",
        )
        .await
        .unwrap();
        let core = PublicationFake {
            valid: true,
            completed: false.into(),
            lose_completion: false.into(),
        };
        let result = finish_removal(&core, &root, &root.join("transfers/qwen3-06b"), "qwen3-06b")
            .await
            .unwrap();
        assert_eq!(result["freedBytes"], 5);
    }
    struct InterruptedRollback {
        core: PublicationFake,
        fail_once: std::sync::atomic::AtomicBool,
        request_ids: std::sync::Mutex<Vec<Value>>,
    }
    impl PublicationControl for InterruptedRollback {
        fn request<'a>(
            &'a self,
            method: &'a str,
            path: &'a str,
            body: Option<Value>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
        {
            Box::pin(async move {
                if path.ends_with("/maintenance") {
                    self.request_ids
                        .lock()
                        .unwrap()
                        .push(body.as_ref().unwrap()["request_id"].clone());
                }
                if path.ends_with("/complete")
                    && self
                        .fail_once
                        .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    return Err("Core unavailable before completion".into());
                }
                self.core.request(method, path, body).await
            })
        }
    }
    #[tokio::test]
    async fn fastflowlm_review_rollback_stays_pending_until_the_original_guard_completes() {
        let (_temp, root, journal, mut job) = publication_fixture().await;
        let core = InterruptedRollback {
            core: PublicationFake {
                valid: false,
                completed: false.into(),
                lose_completion: false.into(),
            },
            fail_once: true.into(),
            request_ids: Default::default(),
        };
        assert!(publish(&core, &root, &journal, &mut job)
            .await
            .unwrap_err()
            .contains("unavailable"));
        assert_ne!(
            job["state"], "rolled-back",
            "A rollback without acknowledged completion must be recoverable"
        );
        let mut restarted = read_document(&journal).await.unwrap().unwrap();
        assert!(publish(&core, &root, &journal, &mut restarted)
            .await
            .unwrap_err()
            .contains("Invalid local config"));
        assert_eq!(restarted["state"], "rolled-back");
        assert_eq!(
            *core.request_ids.lock().unwrap(),
            vec![job["plan"]["request_id"].clone(); 2]
        );
        assert!(core
            .core
            .completed
            .load(std::sync::atomic::Ordering::SeqCst));
    }
    #[tokio::test]
    async fn fastflowlm_review_same_digest_reinstall_replaces_the_old_bytes() {
        let (_temp, root, journal, mut job) = publication_fixture().await;
        let stage = root.join("transfers/qwen3-06b/model");
        let target = root.join("models/qwen3-06b");
        write_document(
            &target.join("model.yml"),
            &json!({"fastflowlm":{"catalog_digest":job["plan"]["digest"]}}),
        )
        .await
        .unwrap();
        tokio::fs::write(target.join("weights.bin"), b"bad!!")
            .await
            .unwrap();
        tokio::fs::write(stage.join("weights.bin"), b"valid")
            .await
            .unwrap();
        let core = PublicationFake {
            valid: true,
            completed: false.into(),
            lose_completion: false.into(),
        };
        publish(&core, &root, &journal, &mut job).await.unwrap();
        assert_eq!(
            tokio::fs::read(target.join("weights.bin")).await.unwrap(),
            b"valid"
        );
        assert!(!stage.exists());
    }
    #[tokio::test]
    async fn fastflowlm_review_legacy_rollback_reconciles_before_becoming_terminal() {
        for completed in [false, true] {
            let (_temp,root,journal,mut job)=publication_fixture().await;
            job["state"]=json!("rolled-back");job["error"]=json!("Original validation failure");
            assert!(publication_pending(&job));assert!(!install_finished(&job));
            let core=PublicationFake{valid:false,completed:completed.into(),lose_completion:false.into()};
            assert!(publish(&core,&root,&journal,&mut job).await.unwrap_err().contains("Original validation failure"));
            let saved=read_document(&journal).await.unwrap().unwrap();
            assert!(install_finished(&saved));assert!(!publication_pending(&saved));
            assert!(core.completed.load(std::sync::atomic::Ordering::SeqCst));
        }
    }

}
