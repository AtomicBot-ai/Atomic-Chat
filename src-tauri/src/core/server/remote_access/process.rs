//! The `cloudflared` child process: how it is launched, what is read out of
//! its output, and how it is ended.
//!
//! `cloudflared tunnel --url <origin>` opens a "quick tunnel": no Cloudflare
//! account, no domain, and a fresh `https://<words>.trycloudflare.com` name on
//! every start. It prints that name, and later a "Registered tunnel
//! connection" line once an edge connection is actually up. Until that second
//! line the name answers with Cloudflare's error 1033, so a URL alone is never
//! treated as ready.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use regex::Regex;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;

use super::Timings;
use crate::core::process_env::sanitize_tokio_command;

/// Printed once an edge connection is registered and the URL can serve.
const REGISTERED_MARKER: &str = "Registered tunnel connection";

/// cloudflared mentions its own control host in failure lines
/// (`https://api.trycloudflare.com/tunnel`); that is never a tunnel.
const API_HOST: &str = "api.trycloudflare.com";

/// File name of the bundled sidecar. Tauri strips the target triple from an
/// `externalBin` entry and places it next to the main executable.
#[cfg(windows)]
const CLOUDFLARED_FILE_NAME: &str = "cloudflared.exe";
#[cfg(not(windows))]
const CLOUDFLARED_FILE_NAME: &str = "cloudflared";

fn tunnel_url_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        // The `regex` crate has no look-around, so the control host is
        // excluded in code (see `OutputParser::feed_line`).
        Regex::new(r"https://([A-Za-z0-9-]+\.trycloudflare\.com)").expect("valid tunnel URL regex")
    })
}

/// What one line-oriented pass over cloudflared's output has established.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ParsedOutput {
    pub url: Option<String>,
    pub registered: bool,
}

impl ParsedOutput {
    /// A URL that can actually serve: minted *and* registered.
    pub fn ready_url(&self) -> Option<&str> {
        self.registered.then_some(self.url.as_deref()).flatten()
    }
}

/// Accumulates [`ParsedOutput`] from output lines. First URL wins: cloudflared
/// prints it once, and a later line must not swap the advertised address.
#[derive(Debug, Default)]
pub(crate) struct OutputParser {
    parsed: ParsedOutput,
}

impl OutputParser {
    /// Returns `true` when this line changed what is known.
    pub fn feed_line(&mut self, line: &str) -> bool {
        let mut changed = false;
        if self.parsed.url.is_none() {
            let found = tunnel_url_regex()
                .captures_iter(line)
                .filter_map(|captures| Some((captures.get(0)?, captures.get(1)?)))
                .find(|(_, host)| !host.as_str().eq_ignore_ascii_case(API_HOST));
            if let Some((url, _)) = found {
                self.parsed.url = Some(url.as_str().to_string());
                changed = true;
            }
        }
        if !self.parsed.registered && line.contains(REGISTERED_MARKER) {
            self.parsed.registered = true;
            changed = true;
        }
        changed
    }

    pub fn snapshot(&self) -> ParsedOutput {
        self.parsed.clone()
    }
}

/// How waiting for a fresh tunnel to become usable ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Ready {
    /// Minted and registered.
    Url(String),
    /// The process ended first.
    Exited { saw_url: bool },
    /// Still running, but not registered within the limit.
    TimedOut { saw_url: bool },
}

/// One running tunnel process, as the supervisor sees it.
///
/// A trait so the manager's state machine can be tested with scripted
/// processes; the real implementation below is tested against a real child.
#[async_trait]
pub(crate) trait TunnelProcess: Send {
    fn pid(&self) -> Option<u32>;
    async fn wait_ready(&mut self, limit: Duration) -> Ready;
    /// Resolves when the process has exited. Cancel safe.
    async fn wait_exit(&mut self);
    /// Ends the process. `false` means its exit could not be confirmed.
    async fn terminate(&mut self, timings: &Timings) -> bool;
}

/// Launches a tunnel for `origin`, optionally forcing a transport protocol.
/// `None` means the bundled binary is missing or could not be started.
pub(crate) type Spawner =
    Arc<dyn Fn(&str, Option<&str>) -> Option<Box<dyn TunnelProcess>> + Send + Sync>;

/// A fully described child process, separate from launching it so tests can
/// substitute another program for cloudflared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TunnelCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
}

/// The bundled sidecar, or `None` when this build does not carry one.
pub(crate) fn bundled_cloudflared() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(CLOUDFLARED_FILE_NAME);
    candidate.is_file().then_some(candidate)
}

/// An empty configuration document for `--config`.
///
/// cloudflared always reads `~/.cloudflared/config.yml` when it exists. A user
/// who also runs a *named* tunnel has ingress rules there, none of which match a
/// quick tunnel's hostname, so cloudflared itself would answer every request
/// through ours with 404. People who want this feature are exactly the ones
/// likely to have that file. Pointing `--config` at an empty document switches
/// the lookup off.
fn empty_config_path() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        Some(PathBuf::from("/dev/null"))
    }
    #[cfg(not(unix))]
    {
        // No `/dev/null` to point at; an empty file reads the same. Best
        // effort: without it the tunnel still works for everybody who has no
        // config file of their own.
        let path = std::env::temp_dir().join("atomic-chat-cloudflared-empty.yml");
        std::fs::write(&path, b"").ok().map(|_| path)
    }
}

pub(crate) fn cloudflared_args(
    origin: &str,
    protocol: Option<&str>,
    empty_config: Option<&std::path::Path>,
) -> Vec<String> {
    let mut args = vec!["tunnel".to_string()];
    if let Some(config) = empty_config {
        args.push("--config".to_string());
        args.push(config.to_string_lossy().into_owned());
    }
    args.extend([
        "--url".to_string(),
        origin.to_string(),
        // The sidecar is signed as part of the app bundle. Left to itself
        // cloudflared replaces its own binary, which breaks that signature.
        "--no-autoupdate".to_string(),
    ]);
    if let Some(protocol) = protocol {
        args.push("--protocol".to_string());
        args.push(protocol.to_string());
    }
    args
}

/// The production [`Spawner`].
pub(crate) fn spawn_bundled(
    origin: &str,
    protocol: Option<&str>,
) -> Option<Box<dyn TunnelProcess>> {
    let Some(program) = bundled_cloudflared() else {
        log::warn!("[remote-access] the bundled cloudflared is missing next to the executable");
        return None;
    };
    let command = TunnelCommand {
        program,
        args: cloudflared_args(origin, protocol, empty_config_path().as_deref()),
        envs: Vec::new(),
    };
    match spawn(&command) {
        Ok(tunnel) => Some(Box::new(tunnel)),
        Err(error) => {
            log::warn!("[remote-access] could not start cloudflared: {error}");
            None
        }
    }
}

/// A real child process plus the parsed view of its output.
pub(crate) struct ChildTunnel {
    child: Child,
    output: watch::Receiver<ParsedOutput>,
}

pub(crate) fn spawn(command: &TunnelCommand) -> std::io::Result<ChildTunnel> {
    let mut process = Command::new(&command.program);
    process.args(&command.args);
    process.stdin(Stdio::null());
    process.stdout(Stdio::piped());
    process.stderr(Stdio::piped());
    // Last line of defence: if the supervisor task is dropped (runtime
    // shutdown), the tunnel must not outlive it.
    process.kill_on_drop(true);

    // cloudflared reads `TUNNEL_*` variables as flags (`TUNNEL_TOKEN`,
    // `TUNNEL_TRANSPORT_PROTOCOL`, `TUNNEL_URL`…). A user who also runs their
    // own tunnels may have them exported; they must not steer ours.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("TUNNEL_") {
            process.env_remove(&key);
        }
    }
    for (key, value) in &command.envs {
        process.env(key, value);
    }
    // cloudflared is a static Go binary and needs nothing from the AppImage
    // runtime; without this it would inherit the bundle's library paths.
    sanitize_tokio_command(&mut process);
    jan_utils::setup_windows_process_flags(&mut process);

    #[cfg(unix)]
    {
        // Its own group, so a Ctrl+C aimed at a dev session's terminal does
        // not reach it behind the supervisor's back.
        process.process_group(0);
    }
    #[cfg(target_os = "linux")]
    {
        // A crash runs none of our cleanup, and an AppImage's mount path
        // changes per launch, so ask the kernel to end the tunnel with us.
        // PDEATHSIG is tied to the *thread* that forks: `spawn` must be called
        // from a runtime worker (which lives as long as the runtime), never
        // from `spawn_blocking`, whose threads are reaped when idle.
        // SAFETY: the closure runs between fork and exec and only makes one
        // async-signal-safe syscall; it allocates nothing and takes no locks.
        unsafe {
            process.pre_exec(|| {
                // `prctl` is variadic and reads this argument as an unsigned
                // long, so pass exactly that width. Best effort: a tunnel
                // without the death signal is still covered by the journal.
                let _ = libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong);
                Ok(())
            });
        }
    }

    let mut child = process.spawn()?;
    let (sender, output) = watch::channel(ParsedOutput::default());
    let parser = Arc::new(StdMutex::new(OutputParser::default()));
    // cloudflared logs to stderr; stdout is read too so neither pipe can fill
    // up and stall the process. tokio cannot merge the two, hence two readers
    // feeding one parser.
    if let Some(stdout) = child.stdout.take() {
        spawn_reader(stdout, parser.clone(), sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(stderr, parser, sender);
    }
    Ok(ChildTunnel { child, output })
}

fn spawn_reader<R>(
    pipe: R,
    parser: Arc<StdMutex<OutputParser>>,
    sender: watch::Sender<ParsedOutput>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        // Keep draining after the URL is known: a full pipe blocks the child.
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("[cloudflared] {line}");
            let snapshot = {
                let Ok(mut parser) = parser.lock() else {
                    continue;
                };
                parser.feed_line(&line).then(|| parser.snapshot())
            };
            if let Some(snapshot) = snapshot {
                sender.send_replace(snapshot);
            }
        }
    });
}

#[async_trait]
impl TunnelProcess for ChildTunnel {
    fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    async fn wait_ready(&mut self, limit: Duration) -> Ready {
        let deadline = tokio::time::sleep(limit);
        tokio::pin!(deadline);
        let mut readers_done = false;
        loop {
            if let Some(url) = self.output.borrow().ready_url() {
                return Ready::Url(url.to_string());
            }
            tokio::select! {
                changed = self.output.changed(), if !readers_done => {
                    // Both readers ended (pipes closed). That is not an exit:
                    // on Windows a grandchild can hold a pipe open, and the
                    // reverse is possible too. Only `wait()` decides.
                    readers_done = changed.is_err();
                }
                _ = self.child.wait() => {
                    return Ready::Exited { saw_url: self.saw_url() };
                }
                _ = &mut deadline => {
                    return Ready::TimedOut { saw_url: self.saw_url() };
                }
            }
        }
    }

    async fn wait_exit(&mut self) {
        let _ = self.child.wait().await;
    }

    async fn terminate(&mut self, timings: &Timings) -> bool {
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            return true;
        }
        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            if let Some(pid) = self.child.id() {
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
                if tokio::time::timeout(timings.term_grace, self.child.wait())
                    .await
                    .is_ok()
                {
                    return true;
                }
                log::warn!("[remote-access] cloudflared ignored SIGTERM; killing pid {pid}");
            }
        }
        // Windows has no graceful signal for a console-less child; go straight
        // to TerminateProcess, as the llama.cpp plugin does.
        let _ = self.child.start_kill();
        tokio::time::timeout(timings.kill_grace, self.child.wait())
            .await
            .is_ok()
    }
}

impl ChildTunnel {
    fn saw_url(&self) -> bool {
        self.output.borrow().url.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE_MODE_ENV: &str = "ATOMIC_FAKE_CLOUDFLARED";
    const FAKE_URL: &str = "https://calm-river-demo.trycloudflare.com";

    fn fast_timings() -> Timings {
        Timings {
            ready: Duration::from_secs(10),
            probe_total: Duration::from_secs(1),
            term_grace: Duration::from_millis(300),
            kill_grace: Duration::from_secs(5),
        }
    }

    /// A cross-platform stand-in for cloudflared with no shell involved: this
    /// very test binary, re-run so that only [`fake_cloudflared_main`] executes.
    /// A `sh -c`/`cmd /C` fake would leave a grandchild holding the pipes.
    fn fake(mode: &str) -> TunnelCommand {
        TunnelCommand {
            program: std::env::current_exe().expect("test binary path"),
            args: vec![
                "--exact".to_string(),
                "core::server::remote_access::process::tests::fake_cloudflared_main".to_string(),
                "--ignored".to_string(),
                "--nocapture".to_string(),
                "--test-threads=1".to_string(),
            ],
            envs: vec![(FAKE_MODE_ENV.to_string(), mode.to_string())],
        }
    }

    /// Not a test: the body of the fake process. Without the env var (a plain
    /// `cargo test -- --ignored`) it returns immediately.
    #[test]
    #[ignore = "re-executed by the tests in this module as a fake cloudflared"]
    fn fake_cloudflared_main() {
        let Ok(mode) = std::env::var(FAKE_MODE_ENV) else {
            return;
        };
        let banner = "2026-09-17T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...";
        let url_line = format!("2026-09-17T10:00:01Z INF |  {FAKE_URL}  |");
        let registered =
            "2026-09-17T10:00:02Z INF Registered tunnel connection connIndex=0 protocol=quic";
        match mode.as_str() {
            "url_then_registered" => {
                eprintln!("{banner}\n{url_line}\n{registered}");
                sleep_forever();
            }
            "url_only" => {
                eprintln!("{banner}\n{url_line}");
                sleep_forever();
            }
            "silent" => sleep_forever(),
            "exit_immediately" => {
                eprintln!(
                    "failed to request quick Tunnel: Post \"https://{API_HOST}/tunnel\": EOF"
                );
                std::process::exit(1);
            }
            "ready_then_exit" => {
                eprintln!("{url_line}\n{registered}");
                std::thread::sleep(Duration::from_millis(300));
                std::process::exit(0);
            }
            #[cfg(unix)]
            "ignore_sigterm" => {
                unsafe {
                    libc::signal(libc::SIGTERM, libc::SIG_IGN);
                }
                eprintln!("{url_line}\n{registered}");
                sleep_forever();
            }
            other => panic!("unknown fake cloudflared mode {other}"),
        }
    }

    fn sleep_forever() -> ! {
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }

    #[test]
    fn the_url_is_pulled_out_of_a_noisy_line() {
        let mut parser = OutputParser::default();
        assert!(!parser.feed_line("INF Requesting new quick Tunnel on trycloudflare.com..."));
        assert!(parser.feed_line(&format!("INF |  {FAKE_URL}  |")));
        assert_eq!(parser.snapshot().url.as_deref(), Some(FAKE_URL));
    }

    #[test]
    fn the_control_host_is_never_mistaken_for_a_tunnel() {
        let mut parser = OutputParser::default();
        assert!(!parser.feed_line(
            "ERR failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": EOF"
        ));
        assert_eq!(parser.snapshot().url, None);
        // …but a real URL on the same line as the control host is still found.
        assert!(parser.feed_line(&format!(
            "INF https://api.trycloudflare.com/tunnel answered {FAKE_URL}"
        )));
        assert_eq!(parser.snapshot().url.as_deref(), Some(FAKE_URL));
    }

    #[test]
    fn a_url_alone_is_not_ready() {
        let mut parser = OutputParser::default();
        parser.feed_line(FAKE_URL);
        assert_eq!(parser.snapshot().ready_url(), None);
        assert!(parser.feed_line("INF Registered tunnel connection connIndex=0"));
        assert_eq!(parser.snapshot().ready_url(), Some(FAKE_URL));
        // Registered again (cloudflared opens several connections): no change.
        assert!(!parser.feed_line("INF Registered tunnel connection connIndex=1"));
    }

    #[test]
    fn the_first_url_wins() {
        let mut parser = OutputParser::default();
        parser.feed_line(FAKE_URL);
        assert!(!parser.feed_line("https://second-name.trycloudflare.com"));
        assert_eq!(parser.snapshot().url.as_deref(), Some(FAKE_URL));
    }

    #[test]
    fn the_command_line_pins_the_origin_and_disables_self_update() {
        assert_eq!(
            cloudflared_args("http://127.0.0.1:1337", None, None),
            [
                "tunnel",
                "--url",
                "http://127.0.0.1:1337",
                "--no-autoupdate"
            ]
        );
        assert_eq!(
            cloudflared_args(
                "http://127.0.0.1:1337",
                Some("http2"),
                Some(std::path::Path::new("/dev/null"))
            ),
            [
                "tunnel",
                "--config",
                "/dev/null",
                "--url",
                "http://127.0.0.1:1337",
                "--no-autoupdate",
                "--protocol",
                "http2"
            ]
        );
    }

    /// Without this a user's own `~/.cloudflared/config.yml` (a named tunnel's
    /// ingress rules) makes cloudflared answer 404 for every request.
    #[test]
    fn the_users_own_cloudflared_config_is_always_switched_off() {
        let config = empty_config_path().expect("an empty config document");
        let body = std::fs::read(&config).expect("readable");
        assert!(body.is_empty(), "{} must read as empty", config.display());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_registered_tunnel_reports_its_url_and_can_be_stopped() {
        let mut tunnel = spawn(&fake("url_then_registered")).expect("spawn fake");
        assert!(tunnel.pid().is_some());
        assert_eq!(
            tunnel.wait_ready(Duration::from_secs(10)).await,
            Ready::Url(FAKE_URL.to_string())
        );
        assert!(tunnel.terminate(&fast_timings()).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_minted_but_unregistered_tunnel_times_out_with_the_url_seen() {
        let mut tunnel = spawn(&fake("url_only")).expect("spawn fake");
        assert_eq!(
            tunnel.wait_ready(Duration::from_millis(1500)).await,
            Ready::TimedOut { saw_url: true }
        );
        assert!(tunnel.terminate(&fast_timings()).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_silent_process_times_out_without_a_url() {
        let mut tunnel = spawn(&fake("silent")).expect("spawn fake");
        assert_eq!(
            tunnel.wait_ready(Duration::from_millis(700)).await,
            Ready::TimedOut { saw_url: false }
        );
        assert!(tunnel.terminate(&fast_timings()).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_early_exit_is_reported_as_an_exit_not_a_timeout() {
        let mut tunnel = spawn(&fake("exit_immediately")).expect("spawn fake");
        assert_eq!(
            tunnel.wait_ready(Duration::from_secs(10)).await,
            Ready::Exited { saw_url: false }
        );
        // Already gone: terminating is a confirmed no-op.
        assert!(tunnel.terminate(&fast_timings()).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_exit_after_ready_is_seen_by_wait_exit() {
        let mut tunnel = spawn(&fake("ready_then_exit")).expect("spawn fake");
        assert_eq!(
            tunnel.wait_ready(Duration::from_secs(10)).await,
            Ready::Url(FAKE_URL.to_string())
        );
        tokio::time::timeout(Duration::from_secs(10), tunnel.wait_exit())
            .await
            .expect("the exit must be observed");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_process_that_ignores_sigterm_is_killed() {
        let mut tunnel = spawn(&fake("ignore_sigterm")).expect("spawn fake");
        assert_eq!(
            tunnel.wait_ready(Duration::from_secs(10)).await,
            Ready::Url(FAKE_URL.to_string())
        );
        let started = std::time::Instant::now();
        assert!(tunnel.terminate(&fast_timings()).await);
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "SIGTERM must get its grace period before the kill"
        );
    }

    #[test]
    fn a_missing_program_is_an_error_not_a_panic() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = runtime.enter();
        let missing = TunnelCommand {
            program: PathBuf::from("/nonexistent/atomic-chat/cloudflared"),
            args: Vec::new(),
            envs: Vec::new(),
        };
        assert!(spawn(&missing).is_err());
    }
}
