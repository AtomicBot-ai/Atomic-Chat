use super::models::{DownloadEvent, DownloadItem, ProgressTracker, ProxyConfig};
use crate::core::app::commands::get_jan_data_folder_path;
use futures_util::StreamExt;
use jan_utils::normalize_path;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_RANGE, RANGE};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tauri::{Emitter, Runtime};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use url::Url;

// ===== UTILITY FUNCTIONS =====

pub fn err_to_string<E: std::fmt::Display>(e: E) -> String {
    format!("Error: {e}")
}

const MAX_STREAM_RETRIES: u32 = 5;
#[cfg(not(test))]
const RETRY_BASE_DELAY_MS: u64 = 1_000;
const RETRY_RESET_PROGRESS_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
enum DownloadRequestError {
    Retryable(String),
    RestartRequired(String),
    Fatal(String),
}

impl std::fmt::Display for DownloadRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Retryable(message) | Self::RestartRequired(message) | Self::Fatal(message) => {
                f.write_str(message)
            }
        }
    }
}

fn retry_delay(retry_count: u32) -> Duration {
    #[cfg(test)]
    {
        let _ = retry_count;
        Duration::from_millis(1)
    }
    #[cfg(not(test))]
    {
        Duration::from_millis(RETRY_BASE_DELAY_MS * (1u64 << retry_count.min(6)))
    }
}

async fn wait_for_retry(delay: Duration, cancel_token: &CancellationToken) -> Result<(), String> {
    tokio::select! {
        _ = tokio::time::sleep(delay) => Ok(()),
        _ = cancel_token.cancelled() => Err("Download cancelled".to_string()),
    }
}

fn expected_download_size(item: &DownloadItem, response_size: u64) -> u64 {
    item.size.filter(|size| *size > 0).unwrap_or(response_size)
}

fn validate_content_range(
    response: &reqwest::Response,
    requested_start: u64,
    expected_size: u64,
) -> Result<(), DownloadRequestError> {
    let value = response
        .headers()
        .get(CONTENT_RANGE)
        .ok_or_else(|| {
            DownloadRequestError::RestartRequired(
                "Resume response is missing the Content-Range header".to_string(),
            )
        })?
        .to_str()
        .map_err(|error| {
            DownloadRequestError::RestartRequired(format!(
                "Resume response has an invalid Content-Range header: {error}"
            ))
        })?;

    let range = value.strip_prefix("bytes ").ok_or_else(|| {
        DownloadRequestError::RestartRequired(format!(
            "Resume response has an unsupported Content-Range value: {value}"
        ))
    })?;
    let (bounds, total) = range.split_once('/').ok_or_else(|| {
        DownloadRequestError::RestartRequired(format!(
            "Resume response has an invalid Content-Range value: {value}"
        ))
    })?;
    let (start, end) = bounds.split_once('-').ok_or_else(|| {
        DownloadRequestError::RestartRequired(format!(
            "Resume response has an invalid Content-Range value: {value}"
        ))
    })?;
    let start = start.parse::<u64>().map_err(|error| {
        DownloadRequestError::RestartRequired(format!(
            "Resume response has an invalid Content-Range start: {error}"
        ))
    })?;
    let end = end.parse::<u64>().map_err(|error| {
        DownloadRequestError::RestartRequired(format!(
            "Resume response has an invalid Content-Range end: {error}"
        ))
    })?;

    if start != requested_start || end < start {
        return Err(DownloadRequestError::RestartRequired(format!(
            "Resume response range does not match the requested offset: requested {requested_start}, got {value}"
        )));
    }

    if total != "*" {
        let total = total.parse::<u64>().map_err(|error| {
            DownloadRequestError::RestartRequired(format!(
                "Resume response has an invalid Content-Range total: {error}"
            ))
        })?;
        if end >= total {
            return Err(DownloadRequestError::RestartRequired(format!(
                "Resume response range exceeds its declared total: {value}"
            )));
        }
        if expected_size > 0 && total != expected_size {
            return Err(DownloadRequestError::RestartRequired(format!(
                "Remote file size changed while resuming: expected {expected_size} bytes, server reports {total} bytes"
            )));
        }
    }

    Ok(())
}

// ===== VALIDATION FUNCTIONS =====

/// Validates a downloaded file against expected hash and size
async fn validate_downloaded_file(
    item: &DownloadItem,
    save_path: &Path,
    app: &tauri::AppHandle<impl Runtime>,
    cancel_token: &CancellationToken,
    emit_event: bool,
) -> Result<(), String> {
    // Skip validation if no verification data is provided
    if item.sha256.is_none() && item.size.is_none() {
        log::debug!(
            "No validation data provided for {}, skipping validation",
            item.url
        );
        return Ok(());
    }

    // Use model_id from item if available, otherwise extract from save path
    // Path structure: llamacpp/models/{modelId}/model.gguf or llamacpp/models/{modelId}/mmproj.gguf
    let model_id = item
        .model_id
        .as_ref()
        .map(|s| s.as_str())
        .unwrap_or_else(|| {
            save_path
                .parent() // get parent directory (modelId folder)
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
        });

    if emit_event {
        app.emit(
            "onModelValidationStarted",
            serde_json::json!({
                "modelId": model_id,
                "downloadType": "Model",
            }),
        )
        .unwrap();
        log::info!("Starting validation for model: {model_id}");
    }

    // Validate size if provided (fast check first)
    if let Some(expected_size) = &item.size {
        log::info!("Starting size verification for {}", item.url);

        match tokio::fs::metadata(save_path).await {
            Ok(metadata) => {
                let actual_size = metadata.len();

                if actual_size != *expected_size {
                    log::error!(
                        "Size verification failed for {}. Expected: {} bytes, Actual: {} bytes",
                        item.url,
                        expected_size,
                        actual_size
                    );
                    return Err(format!(
                        "Size verification failed. Expected {expected_size} bytes but got {actual_size} bytes."
                    ));
                }

                log::info!(
                    "Size verification successful for {} ({} bytes)",
                    item.url,
                    actual_size
                );
            }
            Err(e) => {
                log::error!(
                    "Failed to get file metadata for {}: {}",
                    save_path.display(),
                    e
                );
                return Err(format!("Failed to verify file size: {e}"));
            }
        }
    }

    // Check for cancellation before expensive hash computation
    if cancel_token.is_cancelled() {
        log::info!("Validation cancelled for {}", item.url);
        return Err("Validation cancelled".to_string());
    }

    // Validate hash if provided (expensive check second)
    if let Some(expected_sha256) = &item.sha256 {
        log::info!("Starting Hash verification for {}", item.url);

        match jan_utils::crypto::compute_file_sha256_with_cancellation(save_path, cancel_token)
            .await
        {
            Ok(computed_sha256) => {
                if computed_sha256 != *expected_sha256 {
                    log::error!(
                        "Hash verification failed for {}. Expected: {}, Computed: {}",
                        item.url,
                        expected_sha256,
                        computed_sha256
                    );

                    return Err("Hash verification failed. The downloaded file is corrupted or has been tampered with.".to_string());
                }

                log::info!("Hash verification successful for {}", item.url);
            }
            Err(e) => {
                log::error!(
                    "Failed to compute SHA256 for {}: {}",
                    save_path.display(),
                    e
                );
                return Err(format!("Failed to verify file integrity: {e}"));
            }
        }
    }

    log::info!("All validations passed for {}", item.url);
    Ok(())
}

pub fn validate_proxy_config(config: &ProxyConfig) -> Result<(), String> {
    // Validate proxy URL format
    if let Err(e) = Url::parse(&config.url) {
        return Err(format!("Invalid proxy URL '{}': {e}", config.url));
    }

    // Check if proxy URL has valid scheme
    let url = Url::parse(&config.url).unwrap(); // Safe to unwrap as we just validated it
    match url.scheme() {
        "http" | "https" | "socks4" | "socks5" => {}
        scheme => return Err(format!("Unsupported proxy scheme: {scheme}")),
    }

    // Validate authentication credentials
    if config.username.is_some() && config.password.is_none() {
        return Err("Username provided without password".to_string());
    }

    if config.password.is_some() && config.username.is_none() {
        return Err("Password provided without username".to_string());
    }

    // Validate no_proxy entries
    if let Some(no_proxy) = &config.no_proxy {
        for entry in no_proxy {
            if entry.is_empty() {
                return Err("Empty no_proxy entry".to_string());
            }
            // Basic validation for wildcard patterns
            if entry.starts_with("*.") && entry.len() < 3 {
                return Err(format!("Invalid wildcard pattern: {entry}"));
            }
        }
    }

    // SSL verification settings are all optional booleans, no validation needed

    Ok(())
}

pub fn create_proxy_from_config(config: &ProxyConfig) -> Result<reqwest::Proxy, String> {
    // Validate the configuration first
    validate_proxy_config(config)?;

    let mut proxy = reqwest::Proxy::all(&config.url).map_err(err_to_string)?;

    // Add authentication if provided
    if let (Some(username), Some(password)) = (&config.username, &config.password) {
        proxy = proxy.basic_auth(username, password);
    }

    Ok(proxy)
}

pub fn should_bypass_proxy(url: &str, no_proxy: &[String]) -> bool {
    if no_proxy.is_empty() {
        return false;
    }

    // Parse the URL to get the host
    let parsed_url = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };

    let host = match parsed_url.host_str() {
        Some(h) => h,
        None => return false,
    };

    // Check if host matches any no_proxy entry
    for entry in no_proxy {
        if entry == "*" {
            return true;
        }

        // Simple wildcard matching
        if let Some(domain) = entry.strip_prefix("*.") {
            if host.ends_with(domain) {
                return true;
            }
        } else if host == entry {
            return true;
        }
    }

    false
}

pub fn _get_client_for_item(
    item: &DownloadItem,
    header_map: &HeaderMap,
) -> Result<reqwest::Client, String> {
    let mut client_builder = reqwest::Client::builder()
        // ATO-233: a missing or renamed ggml-org release asset can leave the
        // HEAD request in helpers.rs hanging indefinitely (the CDN accepts the
        // TCP connection but never sends a response).  A 30-second connect
        // timeout caps that worst-case wait so a stale manifest tag fails fast
        // instead of blocking model load forever.
        .connect_timeout(Duration::from_secs(30))
        .http2_keep_alive_timeout(Duration::from_secs(15))
        .default_headers(header_map.clone());

    // Add proxy configuration if provided
    if let Some(proxy_config) = &item.proxy {
        // Handle SSL verification settings
        if proxy_config.ignore_ssl.unwrap_or(false) {
            client_builder = client_builder.danger_accept_invalid_certs(true);
            log::info!("SSL certificate verification disabled for URL {}", item.url);
        }

        // Note: reqwest doesn't have fine-grained SSL verification controls
        // for verify_proxy_ssl, verify_proxy_host_ssl, verify_peer_ssl, verify_host_ssl
        // These settings are handled by the underlying TLS implementation

        // Check if this URL should bypass proxy
        let no_proxy = proxy_config.no_proxy.as_deref().unwrap_or(&[]);
        if !should_bypass_proxy(&item.url, no_proxy) {
            let proxy = create_proxy_from_config(proxy_config)?;
            client_builder = client_builder.proxy(proxy);
            log::info!("Using proxy {} for URL {}", proxy_config.url, item.url);
        } else {
            log::info!("Bypassing proxy for URL {}", item.url);
        }
    }

    client_builder.build().map_err(err_to_string)
}

pub fn _convert_headers(
    headers: &HashMap<String, String>,
) -> Result<HeaderMap, Box<dyn std::error::Error>> {
    let mut header_map = HeaderMap::new();
    for (k, v) in headers {
        let key = HeaderName::from_bytes(k.as_bytes())?;
        let value = HeaderValue::from_str(v)?;
        header_map.insert(key, value);
    }
    Ok(header_map)
}

async fn head_file_size(
    client: &reqwest::Client,
    url: &str,
) -> Result<u64, DownloadRequestError> {
    // ATO-233: 30-second per-request timeout so a slow or unresponsive CDN
    // endpoint (e.g. a 404 redirect chain) fails fast rather than hanging.
    let resp = client
        .head(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| DownloadRequestError::Retryable(error.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        let message = format!("Failed to get file size: HTTP status {status}");
        if status == reqwest::StatusCode::REQUEST_TIMEOUT
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status.is_server_error()
        {
            return Err(DownloadRequestError::Retryable(message));
        }
        return Err(DownloadRequestError::Fatal(message));
    }
    // this is buggy, always return 0 for HEAD request
    // Ok(resp.content_length().unwrap_or(0))

    Ok(resp
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0))
}

async fn head_file_size_with_retry(
    client: &reqwest::Client,
    url: &str,
    cancel_token: &CancellationToken,
) -> Result<u64, DownloadRequestError> {
    let mut retry_count = 0;
    loop {
        match head_file_size(client, url).await {
            Ok(size) => return Ok(size),
            Err(DownloadRequestError::Retryable(error)) if retry_count < MAX_STREAM_RETRIES => {
                if cancel_token.is_cancelled() {
                    return Err(DownloadRequestError::Fatal(
                        "Download cancelled".to_string(),
                    ));
                }
                let delay = retry_delay(retry_count);
                log::warn!(
                    "Preflight HEAD for '{}' failed: {}. Retry {}/{} after {}ms",
                    url,
                    error,
                    retry_count + 1,
                    MAX_STREAM_RETRIES,
                    delay.as_millis()
                );
                wait_for_retry(delay, cancel_token)
                    .await
                    .map_err(DownloadRequestError::Fatal)?;
                retry_count += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Resolves the expected size of a download before it starts.
///
/// ATO-302: the catalog size is preferred over a preflight HEAD request, and a
/// HEAD failure is never fatal — the GET path has its own retry policy and
/// surfaces the real error if the URL is actually unreachable. Only a
/// cancellation aborts the preflight.
pub(super) async fn preflight_file_size(
    client: &reqwest::Client,
    item: &DownloadItem,
    cancel_token: &CancellationToken,
) -> Result<u64, String> {
    if cancel_token.is_cancelled() {
        return Err("Download cancelled".to_string());
    }
    if let Some(size) = item.size.filter(|size| *size > 0) {
        return Ok(size);
    }
    match head_file_size_with_retry(client, &item.url, cancel_token).await {
        Ok(size) => Ok(size),
        Err(error) => {
            if cancel_token.is_cancelled() {
                return Err("Download cancelled".to_string());
            }
            log::warn!(
                "Preflight HEAD for '{}' failed: {}. Continuing with unknown size",
                item.url,
                error
            );
            Ok(0)
        }
    }
}

// ===== MAIN DOWNLOAD FUNCTIONS =====

// Context passed to `download_single_file` to reduce the number of arguments
struct DownloadCtx {
    header_map: HeaderMap,
    resume: bool,
    cancel_token: CancellationToken,
    evt_name: String,
    progress_tracker: ProgressTracker,
}

/// Downloads multiple files in parallel with individual progress tracking
pub async fn _download_files_internal(
    app: tauri::AppHandle<impl Runtime>,
    items: &[DownloadItem],
    headers: &HashMap<String, String>,
    task_id: &str,
    resume: bool,
    cancel_token: CancellationToken,
) -> Result<(), String> {
    log::info!("Start download task: {task_id}");

    let header_map = _convert_headers(headers).map_err(err_to_string)?;

    // Calculate sizes for each file
    let mut file_sizes: HashMap<String, u64> = HashMap::new();
    for item in items.iter() {
        let client = _get_client_for_item(item, &header_map).map_err(err_to_string)?;
        let size = preflight_file_size(&client, item, &cancel_token).await?;
        file_sizes.insert(item.url.clone(), size);
    }

    let total_size: u64 = file_sizes.values().sum();
    log::info!("Total download size: {total_size}");

    let evt_name = format!("download-{task_id}");

    // Create progress tracker
    let progress_tracker = ProgressTracker::new(items, file_sizes.clone());

    // save file under Jan data folder
    let jan_data_folder = get_jan_data_folder_path(app.clone());

    // Collect download tasks for parallel execution
    let mut download_tasks = Vec::new();

    for (index, item) in items.iter().enumerate() {
        let save_path = jan_data_folder.join(&item.save_path);
        let save_path = normalize_path(&save_path);

        if !save_path.starts_with(&jan_data_folder) {
            return Err(format!(
                "Path {} is outside of Jan data folder {}",
                save_path.display(),
                jan_data_folder.display()
            ));
        }

        // Spawn download task for each file
        let item_clone = item.clone();
        let app_clone = app.clone();
        let file_id = format!("{task_id}-{index}");
        let file_size = file_sizes.get(&item.url).copied().unwrap_or(0);

        let ctx = DownloadCtx {
            header_map: header_map.clone(),
            resume,
            cancel_token: cancel_token.clone(),
            evt_name: evt_name.clone(),
            progress_tracker: progress_tracker.clone(),
        };

        let task = tokio::spawn(async move {
            download_single_file(app_clone, &item_clone, &save_path, file_id, file_size, ctx).await
        });

        download_tasks.push(task);
    }

    // Wait for all downloads to complete
    let mut validation_tasks = Vec::new();
    for (task, item) in download_tasks.into_iter().zip(items.iter()) {
        let result = task.await.map_err(|e| format!("Task join error: {e}"))?;

        match result {
            Ok(downloaded_path) => {
                // Spawn validation task in parallel
                let item_clone = item.clone();
                let app_clone = app.clone();
                let path_clone = downloaded_path.clone();
                let cancel_token_clone = cancel_token.clone();
                let validation_task = tokio::spawn(async move {
                    validate_downloaded_file(
                        &item_clone,
                        &path_clone,
                        &app_clone,
                        &cancel_token_clone,
                        false,
                    )
                    .await
                });
                validation_tasks.push((validation_task, downloaded_path, item.clone()));
            }
            Err(e) => return Err(e),
        }
    }

    let model_id = items
        .iter()
        .find_map(|item| item.model_id.as_ref())
        .map(|s| s.as_str())
        .or_else(|| {
            items.first().and_then(|item| {
                std::path::Path::new(&item.save_path)
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
            })
        })
        .unwrap_or("unknown");

    if !validation_tasks.is_empty()
        && items
            .iter()
            .any(|item| item.sha256.is_some() || item.size.is_some())
    {
        app.emit(
            "onModelValidationStarted",
            serde_json::json!({
                "modelId": model_id,
                "downloadType": "Model",
            }),
        )
        .unwrap();
        log::info!("Starting validation for model: {model_id}");
    }

    // Wait for all validations to complete
    for (validation_task, save_path, _item) in validation_tasks {
        let validation_result = validation_task
            .await
            .map_err(|e| format!("Validation task join error: {e}"))?;

        if let Err(validation_error) = validation_result {
            // Clean up the file if validation fails
            let _ = tokio::fs::remove_file(&save_path).await;

            // Try to clean up the parent directory if it's empty
            if let Some(parent) = save_path.parent() {
                let _ = tokio::fs::remove_dir(parent).await;
            }

            return Err(validation_error);
        }
    }

    // Emit final progress
    let (transferred, total) = progress_tracker.get_total_progress().await;
    let final_evt = DownloadEvent { transferred, total };
    app.emit(&evt_name, final_evt).unwrap();
    Ok(())
}

/// Downloads a single file without blocking other downloads
async fn download_single_file(
    app: tauri::AppHandle<impl Runtime>,
    item: &DownloadItem,
    save_path: &std::path::Path,
    file_id: String,
    file_size: u64,
    ctx: DownloadCtx,
) -> Result<std::path::PathBuf, String> {
    let DownloadCtx {
        header_map,
        resume,
        cancel_token,
        evt_name,
        progress_tracker,
    } = ctx;
    let keep_partial_on_cancel = true;
    // Create parent directories if they don't exist
    if let Some(parent) = save_path.parent() {
        if !parent.exists() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(err_to_string)?;
        }
    }

    let current_extension = save_path.extension().unwrap_or_default().to_string_lossy();
    let append_extension = |ext: &str| {
        if current_extension.is_empty() {
            ext.to_string()
        } else {
            format!("{current_extension}.{ext}")
        }
    };
    let tmp_save_path = save_path.with_extension(append_extension("tmp"));
    let url_save_path = save_path.with_extension(append_extension("url"));

    let mut should_resume = resume
        && tmp_save_path.exists()
        && tokio::fs::read_to_string(&url_save_path)
            .await
            .map(|url| url == item.url) // check if we resume the same URL
            .unwrap_or(false);

    tokio::fs::write(&url_save_path, item.url.clone())
        .await
        .map_err(err_to_string)?;

    // Decode URL for better readability in logs
    let decoded_url = url::Url::parse(&item.url)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| item.url.clone());
    log::info!("Started downloading: {decoded_url}");
    let client = _get_client_for_item(item, &header_map).map_err(err_to_string)?;
    let expected_size = expected_download_size(item, file_size);
    let mut download_delta = 0u64;
    let mut initial_progress = 0u64;

    let (resp, _actual_url) = if should_resume {
        let downloaded_size = tmp_save_path.metadata().map_err(err_to_string)?.len();
        if expected_size > 0 && downloaded_size == expected_size {
            progress_tracker
                .update_progress(&file_id, downloaded_size)
                .await;
            tokio::fs::rename(&tmp_save_path, save_path)
                .await
                .map_err(err_to_string)?;
            let _ = tokio::fs::remove_file(&url_save_path).await;
            log::info!("Completed download was already present for '{}'", item.url);
            return Ok(save_path.to_path_buf());
        }
        if expected_size > 0 && downloaded_size > expected_size {
            log::warn!(
                "Partial file for '{}' is larger than expected ({} > {}); restarting",
                item.url,
                downloaded_size,
                expected_size
            );
            should_resume = false;
            let resp = request_download_response_with_retry(
                &client,
                &item.url,
                0,
                expected_size,
                &cancel_token,
            )
            .await
            .map_err(|error| error.to_string())?;
            (resp, item.url.clone())
        } else {
            match request_download_response_with_retry(
                &client,
                &item.url,
                downloaded_size,
                expected_size,
                &cancel_token,
            )
            .await
            {
                Ok(resp) => {
                    log::info!(
                        "Resume download: {}, already downloaded {} bytes",
                        item.url,
                        downloaded_size
                    );
                    initial_progress = downloaded_size;

                    // Initialize progress for resumed download
                    progress_tracker
                        .update_progress(&file_id, downloaded_size)
                        .await;

                    // Emit initial combined progress
                    let (combined_transferred, combined_total) =
                        progress_tracker.get_total_progress().await;
                    let evt = DownloadEvent {
                        transferred: combined_transferred,
                        total: combined_total,
                    };
                    app.emit(&evt_name, evt).unwrap();

                    (resp, item.url.clone())
                }
                Err(DownloadRequestError::RestartRequired(error)) => {
                    log::warn!("Resume is unavailable for '{}': {error}", item.url);
                    let resp = request_download_response_with_retry(
                        &client,
                        &item.url,
                        0,
                        expected_size,
                        &cancel_token,
                    )
                    .await
                    .map_err(|request_error| request_error.to_string())?;
                    should_resume = false;
                    (resp, item.url.clone())
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    } else {
        let resp = request_download_response_with_retry(
            &client,
            &item.url,
            0,
            expected_size,
            &cancel_token,
        )
        .await
        .map_err(|error| error.to_string())?;
        (resp, item.url.clone())
    };

    let mut stream = resp.bytes_stream();

    let file = if should_resume {
        // resume download, append to existing file
        tokio::fs::OpenOptions::new()
            .write(true)
            .append(true)
            .open(&tmp_save_path)
            .await
            .map_err(err_to_string)?
    } else {
        // start new download, create a new file
        File::create(&tmp_save_path).await.map_err(err_to_string)?
    };
    let mut writer = tokio::io::BufWriter::new(file);
    let mut total_transferred = initial_progress;
    let mut retry_count = 0u32;
    let mut progress_since_retry_reset = 0u64;

    // write chunk to file
    loop {
        let stream_error = match stream.next().await {
            None if expected_size > 0 && total_transferred < expected_size => Some(format!(
                "stream ended after {total_transferred} of {expected_size} bytes"
            )),
            None => break,
            Some(Ok(chunk)) => {
                if cancel_token.is_cancelled() {
                    if !keep_partial_on_cancel && !should_resume {
                        tokio::fs::remove_dir_all(&save_path.parent().unwrap())
                            .await
                            .ok();
                    }
                    log::info!("Download cancelled: {}", item.url);
                    return Err("Download cancelled".to_string());
                }

                writer.write_all(&chunk).await.map_err(err_to_string)?;
                download_delta += chunk.len() as u64;
                total_transferred += chunk.len() as u64;
                progress_since_retry_reset += chunk.len() as u64;
                if progress_since_retry_reset >= RETRY_RESET_PROGRESS_BYTES {
                    retry_count = 0;
                    progress_since_retry_reset = 0;
                }

                // Update progress every 10 MB
                if download_delta >= 10 * 1024 * 1024 {
                    // Update individual file progress
                    progress_tracker
                        .update_progress(&file_id, total_transferred)
                        .await;

                    // Emit combined progress event
                    let (combined_transferred, combined_total) =
                        progress_tracker.get_total_progress().await;
                    let evt = DownloadEvent {
                        transferred: combined_transferred,
                        total: combined_total,
                    };
                    app.emit(&evt_name, evt).unwrap();

                    download_delta = 0u64;
                }
                None
            }
            Some(Err(error)) => Some(error.to_string()),
        };

        if let Some(stream_error) = stream_error {
            writer.flush().await.map_err(|error| {
                format!(
                    "Failed to flush partial download before retrying '{}': {error}",
                    item.url
                )
            })?;
            let durable_offset = tokio::fs::metadata(&tmp_save_path)
                .await
                .map_err(err_to_string)?
                .len();
            if durable_offset != total_transferred {
                return Err(format!(
                    "Partial download size mismatch for '{}': tracked {total_transferred} bytes but persisted {durable_offset} bytes",
                    item.url
                ));
            }

            loop {
                if retry_count >= MAX_STREAM_RETRIES {
                    return Err(format!(
                        "Download failed after {MAX_STREAM_RETRIES} retries at byte {durable_offset}: {stream_error}"
                    ));
                }
                if cancel_token.is_cancelled() {
                    return Err("Download cancelled".to_string());
                }
                let delay = retry_delay(retry_count);
                log::warn!(
                    "Stream error at byte {} for '{}': {}. \
                     Retry {}/{} after {}ms",
                    durable_offset,
                    item.url,
                    stream_error,
                    retry_count + 1,
                    MAX_STREAM_RETRIES,
                    delay.as_millis()
                );
                wait_for_retry(delay, &cancel_token).await?;
                retry_count += 1;

                match request_download_response(&client, &item.url, durable_offset, expected_size)
                    .await
                {
                    Ok(response) => {
                        stream = response.bytes_stream();
                        break;
                    }
                    Err(DownloadRequestError::RestartRequired(range_error)) => {
                        match request_download_response(&client, &item.url, 0, expected_size).await
                        {
                            Ok(response) => {
                                let new_file =
                                    File::create(&tmp_save_path).await.map_err(err_to_string)?;
                                writer = tokio::io::BufWriter::new(new_file);
                                progress_tracker.update_progress(&file_id, 0).await;
                                total_transferred = 0;
                                download_delta = 0;
                                progress_since_retry_reset = 0;
                                stream = response.bytes_stream();
                                should_resume = false;
                                log::warn!(
                                    "Server cannot resume '{}' ({}); restarted from byte 0",
                                    item.url,
                                    range_error
                                );
                                break;
                            }
                            Err(DownloadRequestError::Retryable(error)) => {
                                log::warn!(
                                    "Full-download reconnect for '{}' failed: {}",
                                    item.url,
                                    error
                                );
                            }
                            Err(error) => return Err(error.to_string()),
                        }
                    }
                    Err(DownloadRequestError::Retryable(error)) => {
                        log::warn!(
                            "Range reconnect at byte {} for '{}' failed: {}",
                            durable_offset,
                            item.url,
                            error
                        );
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
    }

    writer.flush().await.map_err(err_to_string)?;
    let persisted_size = tokio::fs::metadata(&tmp_save_path)
        .await
        .map_err(err_to_string)?
        .len();
    if persisted_size != total_transferred {
        return Err(format!(
            "Downloaded file size mismatch for '{}': tracked {total_transferred} bytes but persisted {persisted_size} bytes",
            item.url
        ));
    }
    if expected_size > 0 && persisted_size != expected_size {
        return Err(format!(
            "Incomplete download for '{}': expected {expected_size} bytes but received {persisted_size} bytes; partial file was kept for resume",
            item.url
        ));
    }

    // Final progress update for this file
    progress_tracker
        .update_progress(&file_id, total_transferred)
        .await;

    // Emit final combined progress
    let (combined_transferred, combined_total) = progress_tracker.get_total_progress().await;
    let evt = DownloadEvent {
        transferred: combined_transferred,
        total: combined_total,
    };
    app.emit(&evt_name, evt).unwrap();

    // rename tmp file to final file
    tokio::fs::rename(&tmp_save_path, &save_path)
        .await
        .map_err(err_to_string)?;
    tokio::fs::remove_file(&url_save_path)
        .await
        .map_err(err_to_string)?;

    // Decode URL for better readability in logs
    let decoded_url = url::Url::parse(&item.url)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| item.url.clone());
    log::info!("Finished downloading: {decoded_url}");
    Ok(save_path.to_path_buf())
}

#[cfg(test)]
pub(super) async fn download_single_file_for_test(
    app: tauri::AppHandle<tauri::test::MockRuntime>,
    item: &DownloadItem,
    save_path: &Path,
    expected_size: u64,
) -> Result<std::path::PathBuf, String> {
    let file_id = "test-download".to_string();
    let mut sizes = HashMap::new();
    sizes.insert(file_id.clone(), expected_size);
    let ctx = DownloadCtx {
        header_map: HeaderMap::new(),
        resume: false,
        cancel_token: CancellationToken::new(),
        evt_name: "test-download-progress".to_string(),
        progress_tracker: ProgressTracker::new(std::slice::from_ref(item), sizes),
    };
    download_single_file(app, item, save_path, file_id, expected_size, ctx).await
}

#[cfg(test)]
pub(super) async fn validate_downloaded_file_for_test(
    item: &DownloadItem,
    save_path: &Path,
    app: &tauri::AppHandle<tauri::test::MockRuntime>,
) -> Result<(), String> {
    validate_downloaded_file(item, save_path, app, &CancellationToken::new(), false).await
}

// ===== HTTP CLIENT HELPER FUNCTIONS =====

/// Downloads from the original URL directly
pub async fn _get_maybe_resume_with_fallback(
    client: &reqwest::Client,
    url: &str,
    start_bytes: u64,
) -> Result<(reqwest::Response, String), String> {
    log::info!("Downloading from original URL: {}", url);
    let resp = request_download_response(client, url, start_bytes, 0)
        .await
        .map_err(|error| error.to_string())?;
    Ok((resp, url.to_string()))
}

/// Internal function to attempt download from a single URL
async fn request_download_response(
    client: &reqwest::Client,
    url: &str,
    start_bytes: u64,
    expected_size: u64,
) -> Result<reqwest::Response, DownloadRequestError> {
    if start_bytes > 0 {
        let resp = client
            .get(url)
            .header(RANGE, format!("bytes={start_bytes}-"))
            .send()
            .await
            .map_err(|error| DownloadRequestError::Retryable(error.to_string()))?;
        match resp.status() {
            reqwest::StatusCode::PARTIAL_CONTENT => {
                validate_content_range(&resp, start_bytes, expected_size)?;
                Ok(resp)
            }
            reqwest::StatusCode::OK | reqwest::StatusCode::RANGE_NOT_SATISFIABLE => {
                let status = resp.status();
                Err(DownloadRequestError::RestartRequired(format!(
                    "Server did not accept resume offset {start_bytes}: HTTP status {status}"
                )))
            }
            status
                if status == reqwest::StatusCode::REQUEST_TIMEOUT
                    || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || status.is_server_error() =>
            {
                Err(DownloadRequestError::Retryable(format!(
                    "Resume request failed with HTTP status {status}"
                )))
            }
            status => {
                let body = resp.text().await.unwrap_or_default();
                Err(DownloadRequestError::Fatal(format!(
                    "Failed to resume download: HTTP status {status}, {body}"
                )))
            }
        }
    } else {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|error| DownloadRequestError::Retryable(error.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let message = format!("Failed to download: HTTP status {status}, {body}");
            if status == reqwest::StatusCode::REQUEST_TIMEOUT
                || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error()
            {
                return Err(DownloadRequestError::Retryable(message));
            }
            return Err(DownloadRequestError::Fatal(message));
        }
        Ok(resp)
    }
}

async fn request_download_response_with_retry(
    client: &reqwest::Client,
    url: &str,
    start_bytes: u64,
    expected_size: u64,
    cancel_token: &CancellationToken,
) -> Result<reqwest::Response, DownloadRequestError> {
    let mut retry_count = 0;
    loop {
        match request_download_response(client, url, start_bytes, expected_size).await {
            Ok(response) => return Ok(response),
            Err(DownloadRequestError::Retryable(error)) if retry_count < MAX_STREAM_RETRIES => {
                if cancel_token.is_cancelled() {
                    return Err(DownloadRequestError::Fatal(
                        "Download cancelled".to_string(),
                    ));
                }
                let delay = retry_delay(retry_count);
                log::warn!(
                    "Download request for '{}' failed: {}. Retry {}/{} after {}ms",
                    url,
                    error,
                    retry_count + 1,
                    MAX_STREAM_RETRIES,
                    delay.as_millis()
                );
                wait_for_retry(delay, cancel_token)
                    .await
                    .map_err(DownloadRequestError::Fatal)?;
                retry_count += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

pub async fn _get_maybe_resume(
    client: &reqwest::Client,
    url: &str,
    start_bytes: u64,
) -> Result<reqwest::Response, String> {
    request_download_response(client, url, start_bytes, 0)
        .await
        .map_err(|error| error.to_string())
}
