//! State-machine tests for [`RemoteAccessManager`], driven by scripted tunnel
//! processes and a scripted prober: no cloudflared, no network, no sleeps
//! beyond a few milliseconds. The real process handling has its own tests in
//! `process`, the real probe in `probe`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::Mutex;

use super::probe::Prober;
use super::process::{Ready, TunnelProcess};
use super::*;

const URL: &str = "https://calm-river-demo.trycloudflare.com";
const HOST: &str = "calm-river-demo.trycloudflare.com";
/// Far above any real pid, so `kill_pid` can never hit a live process.
const GHOST_PID: u32 = u32::MAX - 11;

/// What one spawned process will do.
#[derive(Clone)]
struct Script {
    pid: Option<u32>,
    /// `None` never becomes ready: it hangs until the supervisor is stopped.
    ready: Option<Ready>,
    /// Exits by itself this long after somebody starts waiting for its exit.
    exits_after: Option<Duration>,
    terminate_confirms: bool,
}

impl Script {
    fn ready_with_url() -> Self {
        Self {
            pid: None,
            ready: Some(Ready::Url(URL.to_string())),
            exits_after: None,
            terminate_confirms: true,
        }
    }

    fn ending_in(ready: Ready) -> Self {
        Self {
            ready: Some(ready),
            ..Self::ready_with_url()
        }
    }

    fn hanging() -> Self {
        Self {
            ready: None,
            ..Self::ready_with_url()
        }
    }
}

#[derive(Default)]
struct Log {
    spawns: Vec<(String, Option<String>)>,
    terminations: usize,
}

struct FakeProcess {
    script: Script,
    log: Arc<StdMutex<Log>>,
}

#[async_trait]
impl TunnelProcess for FakeProcess {
    fn pid(&self) -> Option<u32> {
        self.script.pid
    }

    async fn wait_ready(&mut self, _limit: Duration) -> Ready {
        match self.script.ready.clone() {
            Some(ready) => ready,
            None => std::future::pending().await,
        }
    }

    async fn wait_exit(&mut self) {
        match self.script.exits_after {
            Some(delay) => tokio::time::sleep(delay).await,
            None => std::future::pending().await,
        }
    }

    async fn terminate(&mut self, _timings: &Timings) -> bool {
        self.log.lock().unwrap().terminations += 1;
        self.script.terminate_confirms
    }
}

struct FakeProber {
    reachable: bool,
    delay: Duration,
    calls: AtomicUsize,
}

impl FakeProber {
    fn answering(reachable: bool) -> Self {
        Self {
            reachable,
            delay: Duration::ZERO,
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Prober for FakeProber {
    async fn verify(&self, _url: &str, _budget: Duration) -> bool {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(self.delay).await;
        self.reachable
    }
}

struct Rig {
    manager: Arc<RemoteAccessManager>,
    endpoint: ServerEndpoint,
    hosts: DynamicTrustedHosts,
    events: Arc<StdMutex<Vec<RemoteAccessStatus>>>,
    log: Arc<StdMutex<Log>>,
    prober: Arc<FakeProber>,
}

/// `scripts` are handed out one per spawn; `None` (or running out) means the
/// bundled binary could not be started.
fn rig(scripts: Vec<Option<Script>>, prober: FakeProber) -> Rig {
    let log = Arc::new(StdMutex::new(Log::default()));
    let queue = Arc::new(StdMutex::new(VecDeque::from(scripts)));
    let prober = Arc::new(prober);

    let spawn_log = log.clone();
    let spawner: process::Spawner = Arc::new(move |origin, protocol| {
        spawn_log
            .lock()
            .unwrap()
            .spawns
            .push((origin.to_string(), protocol.map(str::to_string)));
        let script = queue.lock().unwrap().pop_front().flatten()?;
        Some(Box::new(FakeProcess {
            script,
            log: spawn_log.clone(),
        }) as Box<dyn TunnelProcess>)
    });

    let manager = Arc::new(RemoteAccessManager::with_deps(Deps {
        spawner,
        prober: prober.clone(),
        timings: Timings {
            ready: Duration::from_millis(200),
            probe_total: Duration::from_millis(200),
            term_grace: Duration::from_millis(50),
            kill_grace: Duration::from_millis(50),
        },
    }));
    let events = Arc::new(StdMutex::new(Vec::new()));
    let sink_target = events.clone();
    manager.attach_sink(Arc::new(move |status| {
        sink_target.lock().unwrap().push(status.clone());
    }));

    Rig {
        manager,
        endpoint: Arc::new(Mutex::new(Some(LocalServerEndpoint::new(
            "127.0.0.1",
            1337,
            "/v1",
            "",
        )))),
        hosts: DynamicTrustedHosts::default(),
        events,
        log,
        prober,
    }
}

impl Rig {
    async fn start(&self) -> Result<RemoteAccessStatus, String> {
        self.manager
            .start(self.endpoint.clone(), self.hosts.clone())
            .await
    }

    async fn stop(&self) -> RemoteAccessStatus {
        self.manager.stop(&self.endpoint, &self.hosts).await
    }

    async fn status(&self) -> RemoteAccessStatus {
        self.manager.status(&self.endpoint).await
    }

    /// The first event in `state`, waiting for it if needed.
    async fn event_in(&self, state: RemoteAccessState) -> RemoteAccessStatus {
        for _ in 0..500 {
            let found = self
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|status| status.state == state)
                .cloned();
            if let Some(status) = found {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no {state:?} event within 5s: {:?}", self.states());
    }

    fn states(&self) -> Vec<RemoteAccessState> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|status| status.state)
            .collect()
    }

    fn spawns(&self) -> Vec<(String, Option<String>)> {
        self.log.lock().unwrap().spawns.clone()
    }

    fn terminations(&self) -> usize {
        self.log.lock().unwrap().terminations
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tunnel_goes_from_starting_to_online_and_is_trusted_by_the_proxy() {
    let rig = rig(
        vec![Some(Script::ready_with_url())],
        FakeProber::answering(true),
    );

    let immediate = rig.start().await.expect("start is accepted");
    assert_eq!(immediate.state, RemoteAccessState::Starting);
    assert_eq!(
        immediate.url, None,
        "the URL is not shown before it is proven"
    );
    assert!(immediate.can_stop && !immediate.can_start);

    let online = rig.event_in(RemoteAccessState::Online).await;
    assert_eq!(online.url.as_deref(), Some(URL));
    assert_eq!(online.error, None);
    assert!(online.can_stop && !online.can_start);
    assert_eq!(rig.hosts.tunnel_host().as_deref(), Some(HOST));
    // cloudflared chooses its own transport on the first attempt, and points
    // at the address the server is actually reachable on.
    assert_eq!(rig.spawns(), [("http://127.0.0.1:1337".to_string(), None)]);
    assert_eq!(rig.prober.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_origin_follows_a_server_bound_to_one_specific_address() {
    let rig = rig(
        vec![Some(Script::ready_with_url())],
        FakeProber::answering(true),
    );
    // Such a server does not listen on loopback at all.
    *rig.endpoint.lock().await = Some(LocalServerEndpoint::new("192.168.1.5", 8080, "/v1", "k"));
    rig.start().await.unwrap();
    let online = rig.event_in(RemoteAccessState::Online).await;
    assert_eq!(rig.spawns()[0].0, "http://192.168.1.5:8080");
    assert!(online.server_has_api_key);
}

#[tokio::test(flavor = "multi_thread")]
async fn starting_without_a_server_is_refused() {
    let rig = rig(vec![], FakeProber::answering(true));
    *rig.endpoint.lock().await = None;

    assert_eq!(rig.start().await, Err("server_stopped".to_string()));
    let status = rig.status().await;
    assert_eq!(status.state, RemoteAccessState::Off);
    assert_eq!(
        status.block_reason,
        Some(RemoteAccessBlockReason::ServerStopped)
    );
    assert!(!status.can_start);
    assert!(rig.spawns().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_binary_is_reported_as_such() {
    let rig = rig(vec![None], FakeProber::answering(true));
    rig.start().await.unwrap();
    let failed = rig.event_in(RemoteAccessState::Error).await;
    assert_eq!(
        failed.error,
        Some(RemoteAccessError::CloudflaredUnavailable)
    );
    assert!(failed.can_start, "the user may try again");
    assert_eq!(rig.hosts.tunnel_host(), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_url_means_cloudflare_was_not_reached_and_is_not_retried() {
    let rig = rig(
        vec![
            Some(Script::ending_in(Ready::Exited { saw_url: false })),
            Some(Script::ready_with_url()),
        ],
        FakeProber::answering(true),
    );
    rig.start().await.unwrap();
    let failed = rig.event_in(RemoteAccessState::Error).await;
    assert_eq!(failed.error, Some(RemoteAccessError::NoUrl));
    assert_eq!(
        rig.spawns().len(),
        1,
        "another transport cannot fix an unreachable API"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_url_that_never_registers_is_retried_over_http2() {
    let rig = rig(
        vec![
            Some(Script::ending_in(Ready::TimedOut { saw_url: true })),
            Some(Script::ready_with_url()),
        ],
        FakeProber::answering(true),
    );
    rig.start().await.unwrap();
    let online = rig.event_in(RemoteAccessState::Online).await;
    assert_eq!(online.url.as_deref(), Some(URL));

    let protocols: Vec<Option<String>> = rig
        .spawns()
        .into_iter()
        .map(|(_, protocol)| protocol)
        .collect();
    assert_eq!(protocols, [None, Some("http2".to_string())]);
    assert_eq!(
        rig.terminations(),
        1,
        "the first attempt is ended before the second starts"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn registration_failing_on_both_transports_gives_up() {
    let rig = rig(
        vec![
            Some(Script::ending_in(Ready::TimedOut { saw_url: true })),
            Some(Script::ending_in(Ready::TimedOut { saw_url: true })),
        ],
        FakeProber::answering(true),
    );
    rig.start().await.unwrap();
    let failed = rig.event_in(RemoteAccessState::Error).await;
    assert_eq!(failed.error, Some(RemoteAccessError::NotRegistered));
    assert_eq!(rig.spawns().len(), 2);
    assert_eq!(rig.prober.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_url_that_does_not_reach_this_server_is_never_shown() {
    let rig = rig(
        vec![Some(Script::ready_with_url())],
        FakeProber::answering(false),
    );
    rig.start().await.unwrap();
    let failed = rig.event_in(RemoteAccessState::Error).await;
    assert_eq!(failed.error, Some(RemoteAccessError::NotReachable));
    assert_eq!(failed.url, None);
    assert_eq!(rig.terminations(), 1, "the useless tunnel is taken down");
    assert_eq!(rig.hosts.tunnel_host(), None);
    assert!(
        !rig.states().contains(&RemoteAccessState::Online),
        "it must never have looked online: {:?}",
        rig.states()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tunnel_that_dies_while_online_turns_into_an_error() {
    let rig = rig(
        vec![Some(Script {
            exits_after: Some(Duration::from_millis(30)),
            ..Script::ready_with_url()
        })],
        FakeProber::answering(true),
    );
    rig.start().await.unwrap();
    rig.event_in(RemoteAccessState::Online).await;

    let failed = rig.event_in(RemoteAccessState::Error).await;
    assert_eq!(failed.error, Some(RemoteAccessError::Exited));
    assert_eq!(failed.url, None, "a dead tunnel's URL must not linger");
    assert!(failed.can_start);
    assert_eq!(rig.hosts.tunnel_host(), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_an_online_tunnel_reports_stopping_then_off() {
    let rig = rig(
        vec![Some(Script::ready_with_url())],
        FakeProber::answering(true),
    );
    rig.start().await.unwrap();
    rig.event_in(RemoteAccessState::Online).await;

    let stopped = rig.stop().await;
    assert_eq!(stopped.state, RemoteAccessState::Off);
    assert_eq!(stopped.url, None);
    assert!(stopped.can_start && !stopped.can_stop);
    assert_eq!(rig.terminations(), 1);
    assert_eq!(rig.hosts.tunnel_host(), None);

    let states = rig.states();
    let stopping = states
        .iter()
        .position(|state| *state == RemoteAccessState::Stopping)
        .expect("a stopping event");
    assert!(
        states[stopping..].contains(&RemoteAccessState::Off),
        "off must follow stopping: {states:?}"
    );
}

/// Stop and a failure can land in the same instant (the process dies just as
/// the button is pressed). Whichever the supervisor notices first, the user
/// asked for nothing to be running and nothing is: that is `off`, not an error.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_that_races_with_a_failure_still_ends_in_off() {
    let rig = rig(vec![], FakeProber::answering(true));
    let run = {
        let mut inner = rig.manager.lock();
        inner.run += 1;
        inner.phase = Phase::Stopping;
        inner.run
    };
    rig.hosts.set_tunnel_host(HOST);

    rig.manager
        .end_run(
            run,
            None,
            Phase::Failed(RemoteAccessError::Exited),
            &rig.endpoint,
            &rig.hosts,
        )
        .await;

    let status = rig.status().await;
    assert_eq!(status.state, RemoteAccessState::Off);
    assert_eq!(status.error, None);
    assert!(status.can_start);
    assert_eq!(rig.hosts.tunnel_host(), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_pressed_while_starting_ends_the_attempt() {
    let rig = rig(vec![Some(Script::hanging())], FakeProber::answering(true));
    rig.start().await.unwrap();

    let stopped = rig.stop().await;
    assert_eq!(stopped.state, RemoteAccessState::Off);
    assert_eq!(rig.terminations(), 1);
    assert_eq!(rig.prober.calls.load(Ordering::SeqCst), 0);
    assert!(!rig.states().contains(&RemoteAccessState::Online));
}

#[tokio::test(flavor = "multi_thread")]
async fn asking_twice_starts_one_tunnel() {
    let rig = rig(vec![Some(Script::hanging())], FakeProber::answering(true));
    rig.start().await.unwrap();
    let again = rig.start().await.expect("a second start is not an error");
    assert_eq!(again.state, RemoteAccessState::Starting);
    // Give a wrongly spawned second process time to show up.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(rig.spawns().len(), 1);
    rig.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_process_that_cannot_be_confirmed_dead_blocks_start_until_stop_succeeds() {
    let rig = rig(
        vec![Some(Script {
            pid: Some(GHOST_PID),
            terminate_confirms: false,
            ..Script::ready_with_url()
        })],
        FakeProber::answering(true),
    );
    rig.start().await.unwrap();
    rig.event_in(RemoteAccessState::Online).await;

    let stuck = rig.stop().await;
    assert_eq!(stuck.state, RemoteAccessState::Error);
    assert_eq!(stuck.error, Some(RemoteAccessError::StopFailed));
    assert!(
        stuck.can_stop && !stuck.can_start,
        "only Stop may be offered while a tunnel may still be running"
    );
    assert_eq!(stuck.url, None);
    assert_eq!(
        rig.hosts.tunnel_host(),
        None,
        "a tunnel we gave up on is not trusted any more"
    );
    assert_eq!(rig.start().await, Err("stop_failed".to_string()));

    // The retry goes by pid; this one is long gone, which counts as stopped.
    let cleared = rig.stop().await;
    assert_eq!(cleared.state, RemoteAccessState::Off);
    assert!(cleared.can_start);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_attempt_can_be_dismissed_and_retried() {
    let rig = rig(
        vec![None, Some(Script::ready_with_url())],
        FakeProber::answering(true),
    );
    rig.start().await.unwrap();
    rig.event_in(RemoteAccessState::Error).await;

    assert_eq!(rig.stop().await.state, RemoteAccessState::Off);
    rig.start().await.expect("a fresh start after a failure");
    rig.event_in(RemoteAccessState::Online).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_exit_hook_teardown_cannot_be_undone_by_a_late_supervisor() {
    let rig = rig(
        vec![Some(Script::ready_with_url())],
        FakeProber {
            reachable: true,
            delay: Duration::from_millis(150),
            calls: AtomicUsize::new(0),
        },
    );
    rig.start().await.unwrap();
    // Let the supervisor reach the probe, so the host is already trusted.
    for _ in 0..100 {
        if rig.hosts.tunnel_host().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(rig.hosts.tunnel_host().as_deref(), Some(HOST));

    rig.manager.kill_now(&rig.hosts);
    assert_eq!(rig.hosts.tunnel_host(), None);

    // Well past the moment the probe would have succeeded.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = rig.status().await;
    assert_eq!(status.state, RemoteAccessState::Off);
    assert_eq!(rig.hosts.tunnel_host(), None);
    assert!(!rig.states().contains(&RemoteAccessState::Online));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_live_tunnel_is_journalled_and_the_journal_is_cleared_on_stop() {
    let folder = tempfile::tempdir().unwrap();
    let rig = rig(
        vec![Some(Script {
            pid: Some(GHOST_PID),
            ..Script::ready_with_url()
        })],
        FakeProber::answering(true),
    );
    rig.manager.set_journal_path(folder.path());
    let journal_file = journal::path_in(folder.path());

    rig.start().await.unwrap();
    rig.event_in(RemoteAccessState::Online).await;
    let recorded: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&journal_file).expect("a journal while online"))
            .unwrap();
    assert_eq!(recorded["pid"], json!(GHOST_PID));

    rig.stop().await;
    assert!(
        !journal_file.exists(),
        "a confirmed exit leaves nothing to recover"
    );
}

#[test]
fn the_status_follows_the_server_as_well_as_the_tunnel() {
    let off = Snapshot {
        phase: Phase::Off,
        url: None,
    };
    let keyless = LocalServerEndpoint::new("127.0.0.1", 1337, "/v1", "");
    let keyed = LocalServerEndpoint::new("127.0.0.1", 1337, "/v1", "sk-atomic-x");

    let stopped = derive_status(&off, None);
    assert_eq!(
        stopped.block_reason,
        Some(RemoteAccessBlockReason::ServerStopped)
    );
    assert!(!stopped.can_start && !stopped.can_stop);
    assert!(!stopped.server_has_api_key);

    // The API key is never a reason to refuse: exposing without one is the
    // user's decision, made explicit in the UI.
    let running_keyless = derive_status(&off, Some(&keyless));
    assert_eq!(running_keyless.block_reason, None);
    assert!(running_keyless.can_start);
    assert!(!running_keyless.server_has_api_key);
    assert!(derive_status(&off, Some(&keyed)).server_has_api_key);

    // A URL is only ever reported while online, whatever is stored.
    let starting_with_url = Snapshot {
        phase: Phase::Starting,
        url: Some(URL.to_string()),
    };
    assert_eq!(derive_status(&starting_with_url, Some(&keyed)).url, None);
}

#[test]
fn the_wire_format_is_camel_case_keys_with_snake_case_codes() {
    let online = derive_status(
        &Snapshot {
            phase: Phase::Online,
            url: Some(URL.to_string()),
        },
        Some(&LocalServerEndpoint::new(
            "127.0.0.1",
            1337,
            "/v1",
            "sk-atomic-x",
        )),
    );
    assert_eq!(
        serde_json::to_value(&online).unwrap(),
        json!({
            "state": "online",
            "url": URL,
            "error": null,
            "blockReason": null,
            "canStart": false,
            "canStop": true,
            "serverHasApiKey": true,
        })
    );

    let failed = derive_status(
        &Snapshot {
            phase: Phase::Failed(RemoteAccessError::NotReachable),
            url: None,
        },
        None,
    );
    let wire = serde_json::to_value(&failed).unwrap();
    assert_eq!(wire["state"], "error");
    assert_eq!(wire["error"], "not_reachable");
    assert_eq!(wire["blockReason"], "server_stopped");

    for (error, code) in [
        (
            RemoteAccessError::CloudflaredUnavailable,
            "cloudflared_unavailable",
        ),
        (RemoteAccessError::NoUrl, "no_url"),
        (RemoteAccessError::NotRegistered, "not_registered"),
        (RemoteAccessError::NotReachable, "not_reachable"),
        (RemoteAccessError::Exited, "exited"),
        (RemoteAccessError::StopFailed, "stop_failed"),
    ] {
        assert_eq!(serde_json::to_value(error).unwrap(), json!(code));
    }
}
