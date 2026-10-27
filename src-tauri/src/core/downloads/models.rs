use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// A running `download_files` invocation, as seen by whoever wants to stop it.
#[derive(Clone)]
pub struct DownloadTask {
    pub cancel_token: CancellationToken,
    /// Set when a newer invocation for the same task id takes the id over. The
    /// losing invocation observes the same cancellation as a user-requested
    /// stop, so without this flag it would clean up files the winner is at that
    /// moment writing.
    pub superseded: Arc<AtomicBool>,
}

impl DownloadTask {
    pub fn new() -> Self {
        Self {
            cancel_token: CancellationToken::new(),
            superseded: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Cancel this task on behalf of a newer one claiming its id.
    pub fn supersede(&self) {
        self.superseded.store(true, Ordering::SeqCst);
        self.cancel_token.cancel();
    }

    pub fn was_superseded(&self) -> bool {
        self.superseded.load(Ordering::SeqCst)
    }

    /// Whether `other` is this very task rather than a same-id successor.
    pub fn is_same_task(&self, other: &DownloadTask) -> bool {
        Arc::ptr_eq(&self.superseded, &other.superseded)
    }
}

#[derive(Default)]
pub struct DownloadManagerState {
    pub cancel_tokens: HashMap<String, DownloadTask>,
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct ProxyConfig {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub no_proxy: Option<Vec<String>>, // List of domains to bypass proxy
    pub ignore_ssl: Option<bool>,      // Ignore SSL certificate verification
}

#[derive(serde::Deserialize, Clone, Debug)]
pub struct DownloadItem {
    pub url: String,
    pub save_path: String,
    pub proxy: Option<ProxyConfig>,
    pub sha256: Option<String>,
    pub size: Option<u64>,
    pub model_id: Option<String>,
    /// What a partial file is matched against on resume, in place of `url`.
    /// For sources whose links are signed and expire (Foundry Local's Azure
    /// SAS links): a fresh link to the same file carries the same key, so the
    /// bytes already on disk are kept. Without it the URL itself is the key.
    #[serde(default)]
    pub resume_key: Option<String>,
}

impl DownloadItem {
    /// The identity a partial is saved under (`.url`, the segment map).
    pub fn resume_identity(&self) -> &str {
        self.resume_key.as_deref().unwrap_or(&self.url)
    }
}

/// What a download task is doing while it has no bytes to report.
///
/// ATO — #290: the preflight HEAD and the first GET each run a five-step
/// backoff ladder (1+2+4+8+16s) that emitted nothing at all. A user whose
/// proxy refuses connections therefore stared at "Preparing" and an empty bar
/// for over a minute per file before the first sign that anything was wrong.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStage {
    /// `"connecting"` for the first attempt, `"retrying"` for each one after,
    /// `"stalled"` when an open transfer has stopped delivering bytes.
    pub kind: &'static str,
    pub attempt: u32,
    /// Zero means transport retries remain active until the user stops the task.
    pub max_attempts: u32,
    /// Actual backoff duration, not an attempt-derived UI estimate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl DownloadStage {
    pub const CONNECTING: &'static str = "connecting";
    pub const RETRYING: &'static str = "retrying";
    /// A transfer that was receiving bytes has gone quiet. Field feedback,
    /// 2026-09-29: a dead connection used to hang forever while the panel kept
    /// quoting the last speed and ETA, so the user saw a live download that
    /// had in fact stopped. This is the status the panel shows instead.
    pub const STALLED: &'static str = "stalled";
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct DownloadEvent {
    pub transferred: u64,
    pub total: u64,
    /// Present only on stage updates, which carry no byte counts — consumers
    /// must treat a staged event as "status changed", never as "progress is
    /// now 0", or a retry would rewind the bar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<DownloadStage>,
}

/// Structure to track progress for each file in parallel downloads
#[derive(Clone)]
pub struct ProgressTracker {
    file_progress: Arc<Mutex<HashMap<String, u64>>>,
    total_size: u64,
    /// When the task last emitted a progress event, shared by all its files.
    last_emit: Arc<std::sync::Mutex<Option<std::time::Instant>>>,
}

impl ProgressTracker {
    pub fn new(_items: &[DownloadItem], sizes: HashMap<String, u64>) -> Self {
        let total_size = sizes.values().sum();
        ProgressTracker {
            file_progress: Arc::new(Mutex::new(HashMap::new())),
            total_size,
            last_emit: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Whether the caller may emit a progress event now, at most once per
    /// `interval` for the whole task. Claiming records the time.
    ///
    /// Progress used to go out every 10 MB per file, which on a 0.5 MB/s link
    /// is one update every 20 seconds — a bar that looks frozen and a speed
    /// estimate built from two points a minute. A time-based cadence keeps the
    /// panel live on slow links without flooding the IPC bridge on fast ones.
    pub fn claim_emit(&self, interval: std::time::Duration) -> bool {
        let mut last = self.last_emit.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::Instant::now();
        match *last {
            Some(previous) if now.duration_since(previous) < interval => false,
            _ => {
                *last = Some(now);
                true
            }
        }
    }

    pub async fn update_progress(&self, file_id: &str, transferred: u64) {
        let mut progress = self.file_progress.lock().await;
        progress.insert(file_id.to_string(), transferred);
    }

    pub async fn get_total_progress(&self) -> (u64, u64) {
        let progress = self.file_progress.lock().await;
        let total_transferred: u64 = progress.values().sum();
        (total_transferred, self.total_size)
    }
}
