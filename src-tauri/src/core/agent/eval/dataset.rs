use std::fs::File;
use std::path::{Path, PathBuf};

use parquet::file::reader::{FileReader, SerializedFileReader};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DATASET_ID: &str = "gaia-benchmark/GAIA";
const DATASET_CONFIG: &str = "2023_all";
const DATASET_SPLIT: &str = "validation";
const DATASET_PARQUET_API_BASE: &str = "https://huggingface.co/api/datasets";
const PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GaiaTask {
    pub task_id: String,
    pub question: String,
    pub level: u8,
    pub gold_answer: String,
    pub file_name: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GaiaFilters {
    pub level: Option<u8>,
    pub limit: Option<usize>,
    pub task_id: Option<String>,
}

pub struct GaiaDatasetClient {
    client: reqwest::Client,
    token: String,
    cache_dir: PathBuf,
}

impl GaiaDatasetClient {
    pub fn new(token: String, cache_dir: PathBuf) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("GAIA_HF_TOKEN or HF_TOKEN is required".into());
        }
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|error| format!("Failed to create Hugging Face client: {error}"))?;
        Ok(Self {
            client,
            token,
            cache_dir,
        })
    }

    pub async fn load_tasks(&self, filters: &GaiaFilters) -> Result<Vec<GaiaTask>, String> {
        std::fs::create_dir_all(&self.cache_dir)
            .map_err(|error| format!("Failed to create GAIA cache: {error}"))?;
        let mut tasks = Vec::new();
        let mut offset = 0;
        loop {
            let page_path = self.cache_dir.join(format!("rows-{offset}.json"));
            let page = if page_path.is_file() {
                std::fs::read(&page_path)
                    .map_err(|error| format!("Failed to read {}: {error}", page_path.display()))?
            } else {
                let url = format!(
                    "https://datasets-server.huggingface.co/rows?dataset={DATASET_ID}&config={DATASET_CONFIG}&split={DATASET_SPLIT}&offset={offset}&length={PAGE_SIZE}"
                );
                let response = self
                    .client
                    .get(url)
                    .bearer_auth(&self.token)
                    .send()
                    .await
                    .map_err(|error| format!("Failed to fetch GAIA rows: {error}"))?;
                if response.status() == reqwest::StatusCode::UNAUTHORIZED
                    || response.status() == reqwest::StatusCode::FORBIDDEN
                {
                    return Err(
                        "GAIA access denied. Accept the dataset terms and provide a valid HF token."
                            .into(),
                    );
                }
                let status = response.status();
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|error| format!("Failed to read GAIA response: {error}"))?;
                if status.is_server_error() {
                    eprintln!(
                        "GAIA datasets-server returned {status}; falling back to direct parquet loading"
                    );
                    return self.load_tasks_from_parquet(filters).await;
                }
                if !status.is_success() {
                    return Err(format!(
                        "GAIA datasets-server returned {status}: {}",
                        String::from_utf8_lossy(&bytes)
                    ));
                }
                std::fs::write(&page_path, &bytes)
                    .map_err(|error| format!("Failed to cache {}: {error}", page_path.display()))?;
                bytes.to_vec()
            };
            let rows = parse_dataset_page(&page)?;
            let row_count = rows.len();
            tasks.extend(rows);
            if row_count < PAGE_SIZE {
                break;
            }
            offset += PAGE_SIZE;
        }
        Ok(filter_tasks(tasks, filters))
    }

    async fn load_tasks_from_parquet(
        &self,
        filters: &GaiaFilters,
    ) -> Result<Vec<GaiaTask>, String> {
        let manifest_url = format!(
            "{DATASET_PARQUET_API_BASE}/{DATASET_ID}/parquet/{DATASET_CONFIG}/{DATASET_SPLIT}"
        );
        let response = self
            .client
            .get(&manifest_url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| format!("Failed to fetch GAIA parquet manifest: {error}"))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read GAIA parquet manifest: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "GAIA parquet manifest returned {status}: {}",
                String::from_utf8_lossy(&bytes)
            ));
        }
        let urls: Vec<String> = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid GAIA parquet manifest: {error}"))?;
        if urls.is_empty() {
            return Err("GAIA parquet manifest did not contain any files".to_string());
        }

        let parquet_dir = self.cache_dir.join("parquet");
        std::fs::create_dir_all(&parquet_dir)
            .map_err(|error| format!("Failed to create GAIA parquet cache: {error}"))?;
        let mut paths = Vec::with_capacity(urls.len());
        for (index, url) in urls.iter().enumerate() {
            let path = parquet_dir.join(format!("{DATASET_SPLIT}-{index}.parquet"));
            let cached = std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0);
            if !cached {
                self.download_parquet_file(url, &path).await?;
            }
            paths.push(path);
        }

        let tasks = tokio::task::spawn_blocking(move || parse_parquet_tasks(&paths))
            .await
            .map_err(|error| format!("GAIA parquet parser task failed: {error}"))??;
        Ok(filter_tasks(tasks, filters))
    }

    async fn download_parquet_file(&self, url: &str, path: &Path) -> Result<(), String> {
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| format!("Failed to download GAIA parquet file: {error}"))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read GAIA parquet file: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "GAIA parquet download returned {status}: {}",
                String::from_utf8_lossy(&bytes)
            ));
        }
        if bytes.is_empty() {
            return Err("GAIA parquet download returned an empty file".to_string());
        }
        std::fs::write(path, bytes)
            .map_err(|error| format!("Failed to cache GAIA parquet file: {error}"))
    }

    pub async fn stage_attachment(
        &self,
        task: &GaiaTask,
        workspace: &Path,
    ) -> Result<Option<PathBuf>, String> {
        let Some(file_name) = task.file_name.as_deref().filter(|name| !name.is_empty()) else {
            return Ok(None);
        };
        let safe_name = Path::new(file_name)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Invalid GAIA attachment name: {file_name}"))?;
        let attachment_cache = self.cache_dir.join("attachments");
        std::fs::create_dir_all(&attachment_cache)
            .map_err(|error| format!("Failed to create attachment cache: {error}"))?;
        let cached = attachment_cache.join(format!(
            "{}-{safe_name}",
            safe_cache_component(&task.task_id)?
        ));
        if !cached.is_file() {
            let repo_path = task
                .file_path
                .as_deref()
                .filter(|path| !path.is_empty())
                .unwrap_or(file_name);
            let components = safe_repo_path_components(repo_path)?;
            let mut url = reqwest::Url::parse(&format!(
                "https://huggingface.co/datasets/{DATASET_ID}/resolve/main/"
            ))
            .map_err(|error| format!("Failed to build attachment URL: {error}"))?;
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Failed to build attachment URL".to_string())?;
            segments.pop_if_empty();
            for component in components {
                segments.push(component);
            }
            drop(segments);
            let response = self
                .client
                .get(url)
                .bearer_auth(&self.token)
                .send()
                .await
                .map_err(|error| format!("Failed to download {safe_name}: {error}"))?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("Attachment {safe_name} returned HTTP {status}"));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("Failed to read {safe_name}: {error}"))?;
            std::fs::write(&cached, bytes)
                .map_err(|error| format!("Failed to cache {safe_name}: {error}"))?;
        }
        let staged = workspace.join(safe_name);
        std::fs::copy(&cached, &staged)
            .map_err(|error| format!("Failed to stage {safe_name}: {error}"))?;
        Ok(Some(staged))
    }
}

fn parse_parquet_tasks(paths: &[PathBuf]) -> Result<Vec<GaiaTask>, String> {
    let mut tasks = Vec::new();
    for path in paths {
        let file = File::open(path).map_err(|error| {
            format!(
                "Failed to open GAIA parquet file {}: {error}",
                path.display()
            )
        })?;
        let reader = SerializedFileReader::new(file).map_err(|error| {
            format!(
                "Failed to read GAIA parquet file {}: {error}",
                path.display()
            )
        })?;
        let rows = reader.get_row_iter(None).map_err(|error| {
            format!(
                "Failed to iterate GAIA parquet file {}: {error}",
                path.display()
            )
        })?;
        for row in rows {
            let value = row
                .map_err(|error| {
                    format!(
                        "Failed to decode GAIA parquet row in {}: {error}",
                        path.display()
                    )
                })?
                .to_json_value();
            tasks.push(parse_task_row(&value)?);
        }
    }
    if tasks.is_empty() {
        return Err("GAIA parquet files did not contain any tasks".to_string());
    }
    Ok(tasks)
}

fn parse_dataset_page(bytes: &[u8]) -> Result<Vec<GaiaTask>, String> {
    let payload: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid datasets-server JSON: {error}"))?;
    payload
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| "datasets-server response has no rows array".to_string())?
        .iter()
        .map(|entry| parse_task_row(entry.get("row").unwrap_or(entry)))
        .collect()
}

fn parse_task_row(row: &Value) -> Result<GaiaTask, String> {
    let value = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| row.get(*name))
            .and_then(value_as_string)
    };
    let task_id = value(&["task_id", "Task ID", "taskId"])
        .ok_or_else(|| "GAIA row has no task id".to_string())?;
    let question = value(&["Question", "question"])
        .ok_or_else(|| format!("GAIA task {task_id} has no question"))?;
    let gold_answer = value(&["Final answer", "final_answer", "answer"])
        .ok_or_else(|| format!("GAIA task {task_id} has no final answer"))?;
    let level = value(&["Level", "level"])
        .and_then(|level| {
            level
                .trim_start_matches(|character: char| !character.is_ascii_digit())
                .parse::<u8>()
                .ok()
        })
        .ok_or_else(|| format!("GAIA task {task_id} has invalid level"))?;
    let file_name = value(&["file_name", "File", "file"])
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.trim().to_string());
    let file_path = value(&["file_path"])
        .filter(|path| !path.trim().is_empty())
        .map(|path| path.trim().to_string());
    Ok(GaiaTask {
        task_id,
        question,
        level,
        gold_answer,
        file_name,
        file_path,
    })
}

fn safe_repo_path_components(path: &str) -> Result<Vec<&str>, String> {
    let path = Path::new(path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!("Invalid GAIA attachment path: {}", path.display()));
    }
    let components = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    if components.is_empty() {
        return Err("GAIA attachment path is empty".into());
    }
    Ok(components)
}

fn safe_cache_component(value: &str) -> Result<String, String> {
    let component = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if component.is_empty() {
        return Err("GAIA task id is empty".into());
    }
    Ok(component)
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

pub fn filter_tasks(mut tasks: Vec<GaiaTask>, filters: &GaiaFilters) -> Vec<GaiaTask> {
    tasks.retain(|task| {
        filters.level.is_none_or(|level| task.level == level)
            && filters
                .task_id
                .as_deref()
                .is_none_or(|task_id| task.task_id == task_id)
    });
    if let Some(limit) = filters.limit {
        tasks.truncate(limit);
    }
    tasks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, level: u8) -> GaiaTask {
        GaiaTask {
            task_id: id.into(),
            question: "Question".into(),
            level,
            gold_answer: "Answer".into(),
            file_name: None,
            file_path: None,
        }
    }

    #[test]
    fn parses_datasets_server_row() {
        let bytes = br#"{"rows":[{"row":{"task_id":"abc","Question":"Q?","Level":"2","Final answer":"42","file_name":"table.xlsx","file_path":"2023/validation/table.xlsx"}}]}"#;
        assert_eq!(
            parse_dataset_page(bytes).unwrap(),
            vec![GaiaTask {
                task_id: "abc".into(),
                question: "Q?".into(),
                level: 2,
                gold_answer: "42".into(),
                file_name: Some("table.xlsx".into()),
                file_path: Some("2023/validation/table.xlsx".into()),
            }]
        );
    }

    #[test]
    fn rejects_unsafe_attachment_repo_paths() {
        assert!(safe_repo_path_components("../secret").is_err());
        assert!(safe_repo_path_components("/absolute/file").is_err());
        assert_eq!(
            safe_repo_path_components("2023/validation/table.xlsx").unwrap(),
            vec!["2023", "validation", "table.xlsx"]
        );
    }

    #[test]
    fn sanitizes_task_ids_used_as_cache_components() {
        assert_eq!(safe_cache_component("a/b:c").unwrap(), "a_b_c");
        assert!(safe_cache_component("").is_err());
    }

    #[test]
    fn applies_level_task_and_limit_filters() {
        let tasks = vec![task("a", 1), task("b", 2), task("c", 2)];
        let filtered = filter_tasks(
            tasks,
            &GaiaFilters {
                level: Some(2),
                limit: Some(1),
                task_id: None,
            },
        );
        assert_eq!(filtered, vec![task("b", 2)]);
    }
}
