//! Multi-connection download of one file.
//!
//! Hugging Face's CDN caps a single connection well below what the link can
//! carry: on the same machine and file, one stream ran at 1.2–2.1 MB/s and
//! eight at 5.6 MB/s together (field feedback, 2026-09-29: "2 GB shows an
//! hour"). A large file from a server that honours ranges is therefore split
//! into byte ranges, each fetched over its own HTTP/1.1 connection and written
//! in place into a `.tmp` created at full size. A connection that finishes
//! takes over half of the largest range still running, so one slow connection
//! does not decide when the file ends; one that brings next to nothing for a
//! whole idle window is reopened where it stopped, as a silent one is.
//!
//! Resume state lives in `<save_path>.parts`: for every range, where it
//! starts, how far it is on disk, and where it ends. It is replaced atomically
//! (through `.parts.new`), only ever records bytes whose write has returned,
//! and exists exactly as long as the full-size `.tmp` does: it is written
//! before the `.tmp` is extended, and removed only after the `.tmp` became the
//! final file or was truncated back to nothing. A `.tmp` without a `.parts` is
//! therefore always a single-stream partial, safe to append to from its
//! length — which is what the single-stream path and older builds assume.

use super::disk::disk_err_to_string;
use super::helpers::{
    build_client_for_item, next_chunk_with_watchdog, request_download_response,
    request_download_response_with_retry, retry_delay, sidecar_path, wait_for_retry,
    DownloadRequestError, NextChunk, StageReporter, TransferTuning, MAX_STREAM_RETRIES,
    RETRY_RESET_PROGRESS_BYTES,
};
use super::models::{DownloadEvent, DownloadItem, DownloadStage, ProgressTracker};
use reqwest::header::HeaderMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Runtime};
use tokio_util::sync::CancellationToken;

pub(super) const PARTS_EXT: &str = "parts";
const PARTS_NEW_EXT: &str = "parts.new";
const MAP_VERSION: u32 = 1;
/// Bytes a connection gathers before one positional write.
const WRITE_BUFFER_BYTES: usize = 1024 * 1024;

/// The on-disk resume record of a multi-connection download.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub(super) struct SegmentMap {
    version: u32,
    /// The item's resume identity: its `resume_key`, or its URL without one.
    url: String,
    size: u64,
    /// `[start, written, end)` per range: `start..written` is on disk.
    segments: Vec<[u64; 3]>,
}

impl SegmentMap {
    fn transferred(&self) -> u64 {
        self.segments
            .iter()
            .map(|[start, written, _]| written.saturating_sub(*start))
            .sum()
    }
}

fn parts_path(save_path: &Path) -> PathBuf {
    sidecar_path(save_path, PARTS_EXT)
}

fn read_map(save_path: &Path) -> Option<SegmentMap> {
    let text = std::fs::read_to_string(parts_path(save_path)).ok()?;
    serde_json::from_str(&text).ok()
}

async fn write_map(save_path: &Path, map: &SegmentMap) -> Result<(), String> {
    let staging = sidecar_path(save_path, PARTS_NEW_EXT);
    let text = serde_json::to_string(map).map_err(|error| error.to_string())?;
    tokio::fs::write(&staging, text)
        .await
        .map_err(|error| disk_err_to_string(&error))?;
    tokio::fs::rename(&staging, parts_path(save_path))
        .await
        .map_err(|error| disk_err_to_string(&error))
}

/// Bytes of `save_path` a resumed download would not fetch again: the ranges
/// of its segment map when there is one, else the length of its `.tmp`.
///
/// A `.parts` that exists but cannot be read counts as nothing: its `.tmp` is
/// full-size, and its length says nothing about what is in it.
pub(crate) fn downloaded_bytes_on_disk(save_path: &Path) -> u64 {
    if parts_path(save_path).exists() {
        return read_map(save_path).map_or(0, |map| map.transferred());
    }
    std::fs::metadata(sidecar_path(save_path, "tmp")).map_or(0, |meta| meta.len())
}

// ===== The plan: who fetches which bytes =====

#[derive(Debug, Clone, PartialEq)]
struct Segment {
    start: u64,
    /// Handed to the connection working on this range; never taken by a split.
    reserved: u64,
    /// On disk. `start <= written <= reserved <= end`.
    written: u64,
    end: u64,
    /// A connection is working on it.
    active: bool,
}

impl Segment {
    fn new(start: u64, written: u64, end: u64) -> Self {
        Self {
            start,
            reserved: written,
            written,
            end,
            active: false,
        }
    }
}

#[derive(Debug)]
struct Plan {
    segments: Vec<Segment>,
    min_segment: u64,
}

impl Plan {
    /// A new plan for `size` bytes, of which `done_prefix` are already on disk
    /// (a single-stream partial being taken over).
    fn fresh(size: u64, done_prefix: u64, connections: usize, min_segment: u64) -> Self {
        let done_prefix = done_prefix.min(size);
        let mut segments = Vec::new();
        if done_prefix > 0 {
            segments.push(Segment::new(0, done_prefix, done_prefix));
        }
        let rest = size - done_prefix;
        if rest > 0 {
            let count = (rest / min_segment.max(1)).clamp(1, connections.max(1) as u64);
            let base = rest / count;
            let mut from = done_prefix;
            for index in 0..count {
                let to = if index + 1 == count {
                    size
                } else {
                    from + base
                };
                segments.push(Segment::new(from, from, to));
                from = to;
            }
        }
        Self {
            segments,
            min_segment,
        }
    }

    /// The plan a saved map describes, or `None` when the map does not cover
    /// `0..size` exactly once.
    fn from_map(map: &SegmentMap, size: u64, min_segment: u64) -> Option<Self> {
        if map.version != MAP_VERSION || map.size != size {
            return None;
        }
        let mut ranges = map.segments.clone();
        ranges.sort_by_key(|[start, _, _]| *start);
        let mut expected_start = 0;
        for [start, written, end] in &ranges {
            if *start != expected_start || written < start || written > end || end <= start {
                return None;
            }
            expected_start = *end;
        }
        if expected_start != size {
            return None;
        }
        Some(Self {
            segments: ranges
                .into_iter()
                .map(|[start, written, end]| Segment::new(start, written, end))
                .collect(),
            min_segment,
        })
    }

    fn to_map(&self, url: &str, size: u64) -> SegmentMap {
        let mut segments: Vec<[u64; 3]> = self
            .segments
            .iter()
            .map(|segment| [segment.start, segment.written, segment.end])
            .collect();
        segments.sort_by_key(|[start, _, _]| *start);
        SegmentMap {
            version: MAP_VERSION,
            url: url.to_string(),
            size,
            segments,
        }
    }

    fn transferred(&self) -> u64 {
        self.segments
            .iter()
            .map(|segment| segment.written - segment.start)
            .sum()
    }

    fn is_complete(&self) -> bool {
        self.segments
            .iter()
            .all(|segment| segment.written == segment.end)
    }

    /// Work for an idle connection: a range nobody is fetching, else the far
    /// half of the running range with the most left. `None` when every range
    /// left is too small to be worth a second connection.
    fn claim(&mut self) -> Option<usize> {
        if let Some(index) = self
            .segments
            .iter()
            .position(|segment| !segment.active && segment.written < segment.end)
        {
            self.segments[index].active = true;
            return Some(index);
        }
        let (index, left) = self
            .segments
            .iter()
            .enumerate()
            .filter(|(_, segment)| segment.active)
            .map(|(index, segment)| (index, segment.end - segment.reserved))
            .max_by_key(|(_, left)| *left)?;
        if left < 2 * self.min_segment {
            return None;
        }
        let donor = &mut self.segments[index];
        let mid = donor.reserved + left / 2;
        let end = donor.end;
        donor.end = mid;
        let mut taken = Segment::new(mid, mid, end);
        taken.active = true;
        self.segments.push(taken);
        Some(self.segments.len() - 1)
    }

    /// Where the connection on `index` should (re)start, and where it stops.
    fn range_left(&self, index: usize) -> Option<(u64, u64)> {
        let segment = &self.segments[index];
        (segment.written < segment.end).then_some((segment.written, segment.end))
    }

    /// Hand up to `len` bytes of `index` to its connection: the offset they go
    /// to and how many of them are still this range's.
    fn reserve(&mut self, index: usize, len: u64) -> (u64, u64) {
        let segment = &mut self.segments[index];
        let allowed = len.min(segment.end.saturating_sub(segment.reserved));
        let offset = segment.reserved;
        segment.reserved += allowed;
        (offset, allowed)
    }

    fn reached_end(&self, index: usize) -> bool {
        let segment = &self.segments[index];
        segment.reserved >= segment.end
    }

    fn commit(&mut self, index: usize, written_up_to: u64) {
        let segment = &mut self.segments[index];
        segment.written = segment.written.max(written_up_to.min(segment.reserved));
    }

    fn release(&mut self, index: usize) {
        self.segments[index].active = false;
    }
}

// ===== Connections =====

/// Write all of `buf` at `offset`, without touching a shared file cursor.
fn write_all_at(file: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_all_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let (mut buf, mut offset) = (buf, offset);
        while !buf.is_empty() {
            let written = file.seek_write(buf, offset)?;
            if written == 0 {
                return Err(std::io::ErrorKind::WriteZero.into());
            }
            buf = &buf[written..];
            offset += written as u64;
        }
        Ok(())
    }
}

struct Shared {
    plan: Mutex<Plan>,
    file: Arc<std::fs::File>,
    client: reqwest::Client,
    url: String,
    size: u64,
    tuning: TransferTuning,
    cancel: CancellationToken,
}

impl Shared {
    fn plan(&self) -> std::sync::MutexGuard<'_, Plan> {
        self.plan.lock().unwrap_or_else(|error| error.into_inner())
    }
}

#[derive(Debug)]
enum WorkerError {
    Cancelled,
    /// The server stopped honouring ranges, or the file changed under us.
    Restart(String),
    Failed(String),
}

async fn run_worker(
    shared: Arc<Shared>,
    mut index: usize,
    mut first_response: Option<reqwest::Response>,
) -> Result<(), WorkerError> {
    loop {
        fetch_range(&shared, index, first_response.take()).await?;
        let next = shared.plan().claim();
        match next {
            Some(next) => index = next,
            None => return Ok(()),
        }
    }
}

/// Land `buf` at `at` and record it as written.
async fn flush(
    shared: &Arc<Shared>,
    index: usize,
    buf: &mut Vec<u8>,
    at: u64,
) -> Result<(), WorkerError> {
    if buf.is_empty() {
        return Ok(());
    }
    let data = std::mem::replace(buf, Vec::with_capacity(WRITE_BUFFER_BYTES));
    let len = data.len() as u64;
    let file = shared.file.clone();
    tokio::task::spawn_blocking(move || write_all_at(&file, &data, at))
        .await
        .map_err(|error| WorkerError::Failed(format!("Segment write task failed: {error}")))?
        .map_err(|error| WorkerError::Failed(disk_err_to_string(&error)))?;
    shared.plan().commit(index, at + len);
    Ok(())
}

/// Fetch what is left of range `index`, reconnecting from its durable offset
/// on errors and stalls, like the single-stream path does for a whole file.
async fn fetch_range(
    shared: &Arc<Shared>,
    index: usize,
    mut response: Option<reqwest::Response>,
) -> Result<(), WorkerError> {
    let mut retry_count = 0u32;
    let mut progress_since_retry_reset = 0u64;
    loop {
        let range = shared.plan().range_left(index);
        let Some((from, end)) = range else {
            shared.plan().release(index);
            return Ok(());
        };
        let failure = match response.take() {
            Some(response) => {
                stream_range(
                    shared,
                    index,
                    response,
                    &mut progress_since_retry_reset,
                    &mut retry_count,
                )
                .await?
            }
            None => {
                let request = tokio::select! {
                    biased;
                    _ = shared.cancel.cancelled() => return Err(WorkerError::Cancelled),
                    request = request_download_response(
                        &shared.client,
                        &shared.url,
                        from,
                        Some(end - 1),
                        shared.size,
                        shared.tuning.response_timeout,
                    ) => request,
                };
                match request {
                    Ok(response) => {
                        stream_range(
                            shared,
                            index,
                            response,
                            &mut progress_since_retry_reset,
                            &mut retry_count,
                        )
                        .await?
                    }
                    Err(DownloadRequestError::Retryable(error)) => Some(error),
                    Err(DownloadRequestError::RestartRequired(error)) => {
                        return Err(WorkerError::Restart(error))
                    }
                    Err(DownloadRequestError::Fatal(error)) => {
                        return Err(WorkerError::Failed(error))
                    }
                }
            }
        };
        let Some(error) = failure else {
            shared.plan().release(index);
            return Ok(());
        };
        if retry_count >= MAX_STREAM_RETRIES {
            return Err(WorkerError::Failed(format!(
                "Download failed after {MAX_STREAM_RETRIES} retries at byte {from}: {error}"
            )));
        }
        let delay = retry_delay(retry_count);
        log::warn!(
            "Segment {from}-{end} of '{}': {error}. Retry {}/{} after {}ms",
            shared.url,
            retry_count + 1,
            MAX_STREAM_RETRIES,
            delay.as_millis()
        );
        wait_for_retry(delay, &shared.cancel)
            .await
            .map_err(|_| WorkerError::Cancelled)?;
        retry_count += 1;
    }
}

/// Copy one response body into range `index`. `Ok(None)` when the range is
/// done, `Ok(Some(error))` when the connection failed and should be retried.
async fn stream_range(
    shared: &Arc<Shared>,
    index: usize,
    response: reqwest::Response,
    progress_since_retry_reset: &mut u64,
    retry_count: &mut u32,
) -> Result<Option<String>, WorkerError> {
    let tuning = &shared.tuning;
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(WRITE_BUFFER_BYTES);
    let mut buf_at = 0u64;
    let mut buf_since = tokio::time::Instant::now();
    let mut window_start = tokio::time::Instant::now();
    let mut window_bytes = 0u64;
    let failure = loop {
        match next_chunk_with_watchdog(&mut stream, &shared.cancel, tuning, || {}).await {
            NextChunk::Chunk(chunk) => {
                let (offset, allowed, reached_end) = {
                    let mut plan = shared.plan();
                    let (offset, allowed) = plan.reserve(index, chunk.len() as u64);
                    (offset, allowed, plan.reached_end(index))
                };
                if allowed > 0 {
                    if buf.is_empty() {
                        buf_at = offset;
                        buf_since = tokio::time::Instant::now();
                    }
                    buf.extend_from_slice(&chunk[..allowed as usize]);
                    *progress_since_retry_reset += allowed;
                    if *progress_since_retry_reset >= RETRY_RESET_PROGRESS_BYTES {
                        *retry_count = 0;
                        *progress_since_retry_reset = 0;
                    }
                }
                // Landed by size on a fast link, and by age on a slow one:
                // only landed bytes count as progress and go into the map, so
                // a connection gathering its 1 MiB for minutes showed a frozen
                // bar and a "stalled" status while bytes were arriving, and a
                // quit lost up to 1 MiB per connection from the resume point.
                if buf.len() >= WRITE_BUFFER_BYTES
                    || reached_end
                    || (!buf.is_empty() && buf_since.elapsed() >= tuning.progress_interval)
                {
                    flush(shared, index, &mut buf, buf_at).await?;
                }
                // The range ended, or another connection took its tail: this
                // body has nothing more for us, and dropping it closes it.
                if reached_end {
                    break None;
                }
                // A connection that trickles is never silent long enough for
                // the idle watchdog, and once a file's tail is too short to
                // split, no other connection takes its bytes over.
                window_bytes += chunk.len() as u64;
                if window_start.elapsed() >= tuning.idle_timeout {
                    if window_bytes < tuning.slow_window_floor {
                        // "connection" is what the web's failure classifier
                        // reads as a network fault, which this is.
                        break Some(format!(
                            "connection too slow: {window_bytes} bytes in {:.0}s",
                            window_start.elapsed().as_secs_f32()
                        ));
                    }
                    window_start = tokio::time::Instant::now();
                    window_bytes = 0;
                }
            }
            NextChunk::End => {
                break Some("stream ended before the end of its range".to_string());
            }
            NextChunk::Failed(error) => break Some(error),
            NextChunk::Cancelled => {
                flush(shared, index, &mut buf, buf_at).await?;
                return Err(WorkerError::Cancelled);
            }
        }
    };
    // What arrived before a failure is good data: keep it, and resume after it.
    flush(shared, index, &mut buf, buf_at).await?;
    Ok(failure)
}

// ===== The file =====

pub(super) enum SegmentedOutcome {
    /// The file is complete at its save path.
    Done,
    /// Not fetched this way; the caller downloads it over one connection from
    /// byte 0. Nothing of a partial it could misread is left on disk.
    Declined(String),
    /// Not fetched this way, and nothing touched: the single-stream path
    /// handles the file exactly as it would have (a finished or oversized
    /// single-stream partial).
    SingleStream,
}

/// One file of a download task, as the multi-connection path sees it.
pub(super) struct FileJob<'a, R: Runtime> {
    pub app: &'a tauri::AppHandle<R>,
    pub item: &'a DownloadItem,
    pub save_path: &'a Path,
    pub file_id: &'a str,
    pub size: u64,
    /// Resume was asked for, a `.tmp` exists and the `.url` matches
    /// [`DownloadItem::resume_identity`].
    pub resume: bool,
    pub header_map: &'a HeaderMap,
    pub cancel_token: &'a CancellationToken,
    pub evt_name: &'a str,
    pub progress_tracker: &'a ProgressTracker,
    pub tuning: &'a TransferTuning,
    pub stage: &'a StageReporter,
}

/// Whether a file is worth more than one connection.
pub(super) fn eligible(size: u64, tuning: &TransferTuning) -> bool {
    tuning.max_connections > 1 && size >= tuning.segmented_min_size && size > 0
}

/// Make a full-size `.tmp` safe to hand to the single-stream path: shrink it
/// first, then drop the map that explained it.
async fn retire_partial(tmp_path: &Path, save_path: &Path) {
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(tmp_path) {
        let _ = file.set_len(0);
    }
    let _ = tokio::fs::remove_file(parts_path(save_path)).await;
}

async fn emit_progress<R: Runtime>(job: &FileJob<'_, R>, transferred: u64, force: bool) {
    job.progress_tracker
        .update_progress(job.file_id, transferred)
        .await;
    if force
        || job
            .progress_tracker
            .claim_emit(job.tuning.progress_interval)
    {
        let (transferred, total) = job.progress_tracker.get_total_progress().await;
        let _ = job.app.emit(
            job.evt_name,
            DownloadEvent {
                transferred,
                total,
                stage: None,
            },
        );
    }
}

/// Download `job` over several connections, or decline to.
pub(super) async fn download<R: Runtime>(job: FileJob<'_, R>) -> Result<SegmentedOutcome, String> {
    let item = job.item;
    let tmp_path = sidecar_path(job.save_path, "tmp");
    let url_path = sidecar_path(job.save_path, "url");
    let map_path = parts_path(job.save_path);
    let tuning = job.tuning;

    // What is on disk decides where the ranges start.
    let saved_plan = if job.resume && map_path.exists() {
        read_map(job.save_path)
            .filter(|map| map.url == item.resume_identity())
            .filter(|_| std::fs::metadata(&tmp_path).is_ok_and(|meta| meta.len() == job.size))
            .and_then(|map| Plan::from_map(&map, job.size, tuning.min_segment_size))
    } else {
        None
    };
    let (mut plan, keep_tmp) = match saved_plan {
        Some(plan) => (plan, true),
        None if map_path.exists() => {
            // A map we cannot use: plan a new transfer, but keep the old
            // bytes and identity until the server accepts the new one.
            (
                Plan::fresh(job.size, 0, tuning.max_connections, tuning.min_segment_size),
                false,
            )
        }
        None if job.resume => {
            // A single-stream partial: its bytes are the first range, done.
            let prefix = std::fs::metadata(&tmp_path).map_or(0, |meta| meta.len());
            if prefix >= job.size {
                return Ok(SegmentedOutcome::SingleStream);
            }
            (
                Plan::fresh(
                    job.size,
                    prefix,
                    tuning.max_connections,
                    tuning.min_segment_size,
                ),
                prefix > 0,
            )
        }
        None => (
            Plan::fresh(job.size, 0, tuning.max_connections, tuning.min_segment_size),
            false,
        ),
    };

    let client = build_client_for_item(item, job.header_map, true)?;

    // The first range doubles as the probe: a server that ignores ranges
    // answers it with a 200, and the file goes the single-stream way.
    let first = plan.claim();
    let first_response = match first.and_then(|index| plan.range_left(index)) {
        Some((from, end)) => {
            match request_download_response_with_retry(
                &client,
                &item.url,
                from,
                Some(end - 1),
                job.size,
                tuning.response_timeout,
                job.cancel_token,
                Some(job.stage),
            )
            .await
            {
                Ok(response) => Some(response),
                Err(DownloadRequestError::RestartRequired(reason)) => {
                    if map_path.exists() {
                        retire_partial(&tmp_path, job.save_path).await;
                    }
                    return Ok(SegmentedOutcome::Declined(reason));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        None => None,
    };

    // The map goes down before the `.tmp` grows to full size: a full-size
    // `.tmp` is never on disk without the map that explains it.
    write_map(
        job.save_path,
        &plan.to_map(item.resume_identity(), job.size),
    )
    .await?;
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(!keep_tmp)
        .open(&tmp_path)
        .map_err(|error| disk_err_to_string(&error))?;
    file.set_len(job.size)
        .map_err(|error| disk_err_to_string(&error))?;
    tokio::fs::write(&url_path, item.resume_identity())
        .await
        .map_err(|error| disk_err_to_string(&error))?;

    log::info!(
        "Downloading '{}' over up to {} connections ({} of {} bytes already on disk)",
        item.url,
        tuning.max_connections,
        plan.transferred(),
        job.size
    );
    emit_progress(&job, plan.transferred(), true).await;

    let worker_cancel = job.cancel_token.child_token();
    let mut extra_claims = Vec::new();
    for _ in 1..tuning.max_connections {
        match plan.claim() {
            Some(index) => extra_claims.push(index),
            None => break,
        }
    }
    let shared = Arc::new(Shared {
        plan: Mutex::new(plan),
        file: Arc::new(file),
        client,
        url: item.url.clone(),
        size: job.size,
        tuning: tuning.clone(),
        cancel: worker_cancel.clone(),
    });
    let mut workers = tokio::task::JoinSet::new();
    if let Some(index) = first {
        workers.spawn(run_worker(shared.clone(), index, first_response));
    }
    for index in extra_claims {
        workers.spawn(run_worker(shared.clone(), index, None));
    }

    let mut ticker = tokio::time::interval(tuning.progress_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_transferred = shared.plan().transferred();
    let mut last_change = tokio::time::Instant::now();
    let mut last_persist = tokio::time::Instant::now();
    let mut stall_reported = false;
    let mut failure: Option<WorkerError> = None;
    loop {
        tokio::select! {
            joined = workers.join_next() => match joined {
                None => break,
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(WorkerError::Cancelled))) => {}
                Some(Ok(Err(error))) => {
                    if failure.is_none() {
                        failure = Some(error);
                        worker_cancel.cancel();
                    }
                }
                Some(Err(error)) => {
                    if failure.is_none() {
                        failure = Some(WorkerError::Failed(format!("Segment task failed: {error}")));
                        worker_cancel.cancel();
                    }
                }
            },
            _ = ticker.tick() => {
                let (transferred, map) = {
                    let plan = shared.plan();
                    (plan.transferred(), plan.to_map(item.resume_identity(), job.size))
                };
                let now = tokio::time::Instant::now();
                if transferred != last_transferred {
                    last_transferred = transferred;
                    last_change = now;
                    stall_reported = false;
                    emit_progress(&job, transferred, false).await;
                } else if !stall_reported && now - last_change >= tuning.stall_notice {
                    stall_reported = true;
                    job.stage.report(DownloadStage::STALLED, 0);
                }
                if now - last_persist >= tuning.persist_interval {
                    last_persist = now;
                    if let Err(error) = write_map(job.save_path, &map).await {
                        log::warn!("Could not save the segment map of '{}': {error}", item.url);
                    }
                }
            }
        }
    }

    let (complete, transferred, map) = {
        let plan = shared.plan();
        (
            plan.is_complete(),
            plan.transferred(),
            plan.to_map(item.resume_identity(), job.size),
        )
    };
    // Every writer is gone; the handle must close before the rename (Windows).
    drop(shared);

    if job.cancel_token.is_cancelled() {
        let _ = write_map(job.save_path, &map).await;
        log::info!("Download cancelled: {}", item.url);
        return Err("Download cancelled".to_string());
    }
    match failure {
        Some(WorkerError::Restart(reason)) => {
            log::warn!(
                "Server stopped honouring ranges for '{}' ({reason}); restarting over one connection",
                item.url
            );
            retire_partial(&tmp_path, job.save_path).await;
            return Ok(SegmentedOutcome::Declined(reason));
        }
        Some(WorkerError::Failed(error)) => {
            write_map(job.save_path, &map).await?;
            return Err(error);
        }
        Some(WorkerError::Cancelled) | None => {}
    }
    if !complete {
        write_map(job.save_path, &map).await?;
        return Err(format!(
            "Incomplete download for '{}': {transferred} of {} bytes; partial file was kept for resume",
            item.url, job.size
        ));
    }

    emit_progress(&job, transferred, true).await;
    // The final name first, the map after: see the module comment.
    tokio::fs::rename(&tmp_path, job.save_path)
        .await
        .map_err(|error| disk_err_to_string(&error))?;
    let _ = tokio::fs::remove_file(&map_path).await;
    tokio::fs::remove_file(&url_path)
        .await
        .map_err(|error| disk_err_to_string(&error))?;
    log::info!(
        "Finished downloading over several connections: {}",
        item.url
    );
    Ok(SegmentedOutcome::Done)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn a_fresh_plan_covers_the_file_in_equal_ranges() {
        let plan = Plan::fresh(100 * MIB, 0, 8, 16 * MIB);
        // 100 MiB / 16 MiB leaves six ranges, not eight.
        assert_eq!(plan.segments.len(), 6);
        assert_eq!(plan.segments[0].start, 0);
        assert_eq!(plan.segments.last().unwrap().end, 100 * MIB);
        for pair in plan.segments.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        assert_eq!(plan.transferred(), 0);
    }

    #[test]
    fn a_single_stream_partial_becomes_a_finished_first_range() {
        let plan = Plan::fresh(100 * MIB, 30 * MIB, 8, 16 * MIB);
        assert_eq!(plan.segments[0], Segment::new(0, 30 * MIB, 30 * MIB));
        assert_eq!(plan.transferred(), 30 * MIB);
        assert_eq!(plan.segments[1].start, 30 * MIB);
        assert_eq!(plan.segments.last().unwrap().end, 100 * MIB);
    }

    #[test]
    fn an_idle_connection_takes_the_far_half_of_the_largest_running_range() {
        let mut plan = Plan::fresh(64 * MIB, 0, 1, MIB);
        let first = plan.claim().unwrap();
        assert_eq!(plan.reserve(first, 4 * MIB), (0, 4 * MIB));

        let second = plan.claim().unwrap();
        // 60 MiB were left past the reserved 4 MiB: the donor keeps 30 of them.
        assert_eq!(plan.segments[first].end, 34 * MIB);
        assert_eq!(plan.segments[second].start, 34 * MIB);
        assert_eq!(plan.segments[second].end, 64 * MIB);

        // The donor's connection stops at its new end, mid-chunk.
        plan.reserve(first, 29 * MIB);
        assert_eq!(plan.reserve(first, 4 * MIB), (33 * MIB, MIB));
        assert!(plan.reached_end(first));
    }

    #[test]
    fn ranges_smaller_than_two_minimum_segments_are_not_split() {
        let mut plan = Plan::fresh(40 * MIB, 0, 1, 16 * MIB);
        let first = plan.claim().unwrap();
        plan.reserve(first, 10 * MIB);
        assert_eq!(plan.claim(), None);
    }

    #[test]
    fn the_map_records_only_written_bytes_and_round_trips() {
        let mut plan = Plan::fresh(64 * MIB, 0, 2, 16 * MIB);
        let first = plan.claim().unwrap();
        plan.reserve(first, 8 * MIB);
        plan.commit(first, 5 * MIB);

        let map = plan.to_map("https://example.com/model.gguf", 64 * MIB);
        assert_eq!(map.transferred(), 5 * MIB);
        let restored = Plan::from_map(&map, 64 * MIB, 16 * MIB).unwrap();
        assert_eq!(restored.transferred(), 5 * MIB);
        // A restored range restarts from what was written, not what was reserved.
        assert_eq!(restored.range_left(0), Some((5 * MIB, 32 * MIB)));
    }

    #[test]
    fn a_map_that_does_not_tile_the_file_is_rejected() {
        let url = "https://example.com/model.gguf".to_string();
        let gap = SegmentMap {
            version: MAP_VERSION,
            url: url.clone(),
            size: 100,
            segments: vec![[0, 10, 40], [50, 50, 100]],
        };
        assert!(Plan::from_map(&gap, 100, 1).is_none());
        let past_end = SegmentMap {
            version: MAP_VERSION,
            url: url.clone(),
            size: 100,
            segments: vec![[0, 60, 50], [50, 50, 100]],
        };
        assert!(Plan::from_map(&past_end, 100, 1).is_none());
        let other_size = SegmentMap {
            version: MAP_VERSION,
            url,
            size: 100,
            segments: vec![[0, 0, 100]],
        };
        assert!(Plan::from_map(&other_size, 200, 1).is_none());
    }

    #[test]
    fn bytes_on_disk_come_from_the_map_not_the_full_size_partial() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("model.gguf");
        std::fs::write(sidecar_path(&save_path, "tmp"), vec![0u8; 4096]).unwrap();
        assert_eq!(downloaded_bytes_on_disk(&save_path), 4096);

        let map = SegmentMap {
            version: MAP_VERSION,
            url: "https://example.com/model.gguf".to_string(),
            size: 4096,
            segments: vec![[0, 1000, 2048], [2048, 2148, 4096]],
        };
        std::fs::write(parts_path(&save_path), serde_json::to_string(&map).unwrap()).unwrap();
        assert_eq!(downloaded_bytes_on_disk(&save_path), 1100);

        // An unreadable map vouches for nothing.
        std::fs::write(parts_path(&save_path), "{").unwrap();
        assert_eq!(downloaded_bytes_on_disk(&save_path), 0);
    }
}
