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
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DownloadEvent {
    pub transferred: u64,
    pub total: u64,
}

/// Structure to track progress for each file in parallel downloads
#[derive(Clone)]
pub struct ProgressTracker {
    file_progress: Arc<Mutex<HashMap<String, u64>>>,
    total_size: u64,
}

impl ProgressTracker {
    pub fn new(_items: &[DownloadItem], sizes: HashMap<String, u64>) -> Self {
        let total_size = sizes.values().sum();
        ProgressTracker {
            file_progress: Arc::new(Mutex::new(HashMap::new())),
            total_size,
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
