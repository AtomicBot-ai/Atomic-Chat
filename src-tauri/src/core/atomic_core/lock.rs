//! Reading the core's ownership record: `<data>/atomic-core/instance.lock` and
//! the control token beside it.
//!
//! The core writes the lock when it takes a data folder and updates it to
//! `ready` once its control listener is bound (PLAN.md §3.4). The app never
//! writes either file — it only asks two questions: *is there an owner I can
//! talk to*, and *which endpoint is it on*.
//!
//! Identity, not the PID, decides. PIDs are reused, and a lock left behind by a
//! crashed core would otherwise point at whatever process inherited its number;
//! attaching to that would hang, and reaping around it would spare the wrong
//! processes. So a record only counts as live when a process with that PID
//! exists *and* started at the moment the record says it did.
//!
//! Deliberately not part of that test: what the process is called. A core run
//! from source for development is `bun`, and a core the app started is the
//! bundled binary; pinning the name would reject the first and would add
//! nothing to the second, since the start-time identity already rules out a
//! recycled PID. The proof that an owner really is a core is the authenticated
//! handshake, not its file name.

use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDateTime, TimeZone};
use serde::Deserialize;

pub const CORE_DIR: &str = "atomic-core";
pub const INSTANCE_LOCK_FILE: &str = "instance.lock";
pub const CONTROL_TOKEN_FILE: &str = "control-token";

/// The subset of the lock the app reads. Unknown fields are ignored on purpose:
/// a newer core may add to the record, and refusing to parse it would turn an
/// additive change into an outage.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct LockRecord {
    pub instance_id: String,
    #[serde(default)]
    pub owner_scope: Option<String>,
    pub pid: u32,
    /// Older core builds published only this platform-specific identity.
    #[serde(default)]
    pub process_start_id: Option<String>,
    /// `epoch:<seconds since boot-independent start>`, written so a non-JS
    /// reader can reproduce it — `sysinfo` gives the same number.
    #[serde(default)]
    pub owner_started_at: Option<String>,
    pub protocol: u32,
    pub version: String,
    pub control_host: String,
    pub control_port: u16,
    /// `starting` until the control listener is bound, then `ready`.
    pub state: String,
}

impl LockRecord {
    pub fn is_ready(&self) -> bool {
        self.state == "ready" && self.control_port != 0 && !self.control_host.is_empty()
    }

    pub fn control_base_url(&self) -> String {
        format!("http://{}:{}", self.control_host, self.control_port)
    }
}

/// What the lock file says about this data folder right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockState {
    /// No lock file: nobody owns this folder.
    Free,
    /// A live core owns it. `ready` says whether its control API is up yet.
    Owned(LockRecord),
    /// A record exists but its process is gone or is not the core that wrote
    /// it. The core itself takes such a lock over; the app only needs to know
    /// that attaching is pointless and starting one is allowed.
    Stale(LockRecord),
    /// The file exists but is not a record we understand — same conclusion as
    /// `Stale`, kept separate so the log can say which it was.
    Corrupt,
}

pub fn core_dir(data_folder: &Path) -> PathBuf {
    data_folder.join(CORE_DIR)
}

pub fn instance_lock_path(data_folder: &Path) -> PathBuf {
    core_dir(data_folder).join(INSTANCE_LOCK_FILE)
}

pub fn control_token_path(data_folder: &Path) -> PathBuf {
    core_dir(data_folder).join(CONTROL_TOKEN_FILE)
}

/// Parse a lock record. Separated from the filesystem so the shape stays
/// testable and so callers that already hold the text (the reaper) reuse it.
pub fn parse_lock(text: &str) -> Option<LockRecord> {
    serde_json::from_str::<LockRecord>(text).ok()
}

/// Whether the process named in the record is still the one that wrote it.
pub fn owner_is_live(record: &LockRecord, system: &sysinfo::System) -> bool {
    let Some(process) = system.process(sysinfo::Pid::from_u32(record.pid)) else {
        return false;
    };
    match record.owner_started_at.as_deref() {
        Some(expected) => format!("epoch:{}", process.start_time()) == expected,
        None => {
            // A PID without a comparable identity cannot be disproved. A false
            // dead verdict would allow a second owner, so unknown stays live.
            record
                .process_start_id
                .as_deref()
                .and_then(|id| {
                    legacy_identity_matches(id, sysinfo::System::boot_time(), process.start_time())
                })
                .unwrap_or(true)
        }
    }
}

/// A destructive replacement requires positive identity proof, not merely the
/// fail-closed liveness verdict used to prevent a second owner.
pub fn owner_identity_confirmed(record: &LockRecord, system: &sysinfo::System) -> bool {
    let Some(process) = system.process(sysinfo::Pid::from_u32(record.pid)) else { return false; };
    match record.owner_started_at.as_deref() {
        Some(expected) => format!("epoch:{}", process.start_time()) == expected,
        None => record.process_start_id.as_deref()
            .and_then(|id| legacy_identity_matches(id, sysinfo::System::boot_time(), process.start_time()))
            == Some(true),
    }
}

fn legacy_identity_matches(identity: &str, boot_time: u64, actual_start: u64) -> Option<bool> {
    legacy_start_epoch(identity, boot_time).map(|expected| expected == actual_start)
}

/// Convert the three legacy identities written by the TypeScript core into the
/// epoch seconds exposed by `sysinfo`. This avoids invoking platform tools from
/// the app's startup path while still distinguishing a recycled PID.
fn legacy_start_epoch(identity: &str, boot_time: u64) -> Option<u64> {
    if let Some(ticks) = identity.strip_prefix("linux:") {
        // The core reads /proc/<pid>/stat field 22. USER_HZ is 100 on every
        // Linux desktop target the project ships, matching process-identity.ts.
        return ticks
            .parse::<u64>()
            .ok()
            .and_then(|ticks| boot_time.checked_add(ticks / 100));
    }
    if let Some(value) = identity.strip_prefix("darwin:") {
        let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
        let parsed = NaiveDateTime::parse_from_str(&normalized, "%a %b %e %H:%M:%S %Y").ok()?;
        let local = Local.from_local_datetime(&parsed).single()?;
        return u64::try_from(local.timestamp()).ok();
    }
    if let Some(ticks) = identity.strip_prefix("win32:") {
        // .NET DateTime ticks are 100 ns intervals since year 1. Unix epoch is
        // 621355968000000000 ticks after that origin. `StartTime` is a local
        // DateTime: its ticks describe wall-clock fields and do not contain the
        // UTC offset, so interpret the resulting naive value in the local zone.
        const UNIX_EPOCH_TICKS: i128 = 621_355_968_000_000_000;
        const TICKS_PER_SECOND: i128 = 10_000_000;
        let ticks = ticks.parse::<i128>().ok()?;
        let unix_ticks = ticks.checked_sub(UNIX_EPOCH_TICKS)?;
        let seconds = unix_ticks.div_euclid(TICKS_PER_SECOND);
        let nanos = unix_ticks.rem_euclid(TICKS_PER_SECOND) * 100;
        let naive = chrono::DateTime::from_timestamp(
            i64::try_from(seconds).ok()?,
            u32::try_from(nanos).ok()?,
        )?
        .naive_utc();
        let local = Local.from_local_datetime(&naive).single()?;
        return u64::try_from(local.timestamp()).ok();
    }
    None
}

/// Read and classify the lock for a data folder.
pub fn inspect(data_folder: &Path, system: &sysinfo::System) -> LockState {
    let Ok(text) = std::fs::read_to_string(instance_lock_path(data_folder)) else {
        return LockState::Free;
    };
    let Some(record) = parse_lock(&text) else {
        return LockState::Corrupt;
    };
    if owner_is_live(&record, system) {
        LockState::Owned(record)
    } else {
        LockState::Stale(record)
    }
}

/// Read the control token the owner published. Every `/atomic/v1/*` request
/// carries it as a bearer token; the file is `0600`, which is the only thing
/// keeping other users on the machine out of the control API.
pub fn read_control_token(data_folder: &Path) -> Option<String> {
    let text = std::fs::read_to_string(control_token_path(data_folder)).ok()?;
    let token = text.trim();
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const READY: &str = r#"{
        "instance_id": "i-1",
        "pid": 4242,
        "process_start_id": "linux:1234",
        "owner_started_at": "epoch:1700000000",
        "protocol": 1,
        "version": "0.1.0",
        "data_folder": "/data",
        "control_host": "127.0.0.1",
        "control_port": 51515,
        "state": "ready",
        "acquired_at": "2026-09-16T00:00:00.000Z"
    }"#;

    #[test]
    fn reads_the_endpoint_a_ready_owner_published() {
        let record = parse_lock(READY).unwrap();

        assert!(record.is_ready());
        assert_eq!(record.control_base_url(), "http://127.0.0.1:51515");
        assert_eq!(record.instance_id, "i-1");
        assert_eq!(record.protocol, 1);
    }

    #[test]
    fn an_owner_that_has_not_bound_its_listener_is_not_ready() {
        let starting = READY
            .replace("\"ready\"", "\"starting\"")
            .replace("51515", "0");
        let record = parse_lock(&starting).unwrap();

        assert!(!record.is_ready(), "port 0 is not somewhere to connect to");
    }

    #[test]
    fn a_ready_state_with_no_endpoint_is_still_not_ready() {
        // Defends against a half-written update: state flipped, port not yet in.
        let record = parse_lock(&READY.replace("\"127.0.0.1\"", "\"\"")).unwrap();

        assert!(!record.is_ready());
    }

    #[test]
    fn tolerates_fields_a_newer_core_adds_and_an_absent_identity() {
        let extra = READY.replace(
            "\"state\": \"ready\"",
            "\"state\": \"ready\", \"something_new\": {\"a\": 1}",
        );
        assert!(parse_lock(&extra).is_some());

        let without = READY.replace("\"owner_started_at\": \"epoch:1700000000\",", "");
        assert_eq!(parse_lock(&without).unwrap().owner_started_at, None);
    }

    #[test]
    fn refuses_a_record_missing_what_attaching_needs() {
        assert!(parse_lock("{ not json").is_none());
        assert!(parse_lock("{}").is_none());
        assert!(
            parse_lock(&READY.replace("\"control_port\": 51515,", "")).is_none(),
            "without a port there is nothing to attach to"
        );
        assert!(
            parse_lock(&READY.replace("51515", "70000")).is_none(),
            "a port outside u16 is not a port"
        );
    }

    #[test]
    fn a_folder_with_no_lock_is_free() {
        let dir = tempfile::tempdir().unwrap();
        let system = sysinfo::System::new();

        assert_eq!(inspect(dir.path(), &system), LockState::Free);
    }

    #[test]
    fn an_unparseable_lock_is_corrupt_rather_than_free() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(core_dir(dir.path())).unwrap();
        std::fs::write(instance_lock_path(dir.path()), "{ half-written").unwrap();
        let system = sysinfo::System::new();

        assert_eq!(inspect(dir.path(), &system), LockState::Corrupt);
    }

    #[test]
    fn a_lock_whose_process_is_gone_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(core_dir(dir.path())).unwrap();
        // A PID that cannot be running: the max on every platform we ship to is
        // far below this.
        std::fs::write(
            instance_lock_path(dir.path()),
            READY.replace("4242", "4294967000"),
        )
        .unwrap();
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        assert!(matches!(
            inspect(dir.path(), &system),
            LockState::Stale(record) if record.instance_id == "i-1"
        ));
    }

    #[test]
    fn a_recycled_pid_is_not_the_owner_that_wrote_the_lock() {
        // This process is alive and its PID is real; the start-time identity is
        // the only thing separating it from the core that once had this number.
        let live = LockRecord {
            instance_id: "i".into(),
            owner_scope: None,
            pid: std::process::id(),
            process_start_id: None,
            owner_started_at: None,
            protocol: 1,
            version: "0.1.0".into(),
            control_host: "127.0.0.1".into(),
            control_port: 1,
            state: "ready".into(),
        };
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        assert!(
            owner_is_live(&live, &system),
            "a record with no identity cannot be disproved, so it counts as live"
        );
        assert!(!owner_identity_confirmed(&live, &system),
            "liveness without start identity never authorizes a replacement shutdown");

        let recycled = LockRecord {
            owner_started_at: Some("epoch:1".into()),
            ..live
        };
        assert!(!owner_is_live(&recycled, &system));
    }

    #[test]
    fn converts_every_legacy_process_identity_to_the_shared_epoch() {
        let epoch = 1_700_001_234_u64;
        let linux = "linux:123400";
        assert_eq!(legacy_start_epoch(linux, 1_700_000_000), Some(epoch));

        let local = Local.timestamp_opt(epoch as i64, 0).single().unwrap();
        let darwin = format!("darwin:{}", local.format("%a %b %e %H:%M:%S %Y"));
        assert_eq!(legacy_start_epoch(&darwin, 0), Some(epoch));

        let local_wall_clock_as_utc = local.naive_local().and_utc().timestamp();
        let windows_ticks =
            621_355_968_000_000_000_i128 + i128::from(local_wall_clock_as_utc) * 10_000_000;
        assert_eq!(
            legacy_start_epoch(&format!("win32:{windows_ticks}"), 0),
            Some(epoch)
        );

        for (identity, boot) in [
            (linux.to_string(), 1_700_000_000),
            (darwin, 0),
            (format!("win32:{windows_ticks}"), 0),
        ] {
            assert_eq!(legacy_identity_matches(&identity, boot, epoch), Some(true));
            assert_eq!(
                legacy_identity_matches(&identity, boot, epoch + 1),
                Some(false),
                "the same PID with another start time is a stale legacy owner"
            );
        }
        assert_eq!(legacy_start_epoch("unknown:123", 0), None);
        assert_eq!(
            legacy_identity_matches("unknown:123", 0, epoch),
            None,
            "an identity this platform cannot prove remains fail-closed"
        );
    }

    #[test]
    fn reads_the_token_without_its_trailing_newline_and_rejects_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(core_dir(dir.path())).unwrap();

        assert_eq!(read_control_token(dir.path()), None, "no file, no token");

        std::fs::write(control_token_path(dir.path()), "abc123\n").unwrap();
        assert_eq!(read_control_token(dir.path()).as_deref(), Some("abc123"));

        std::fs::write(control_token_path(dir.path()), "  \n").unwrap();
        assert_eq!(read_control_token(dir.path()), None);
    }
}
