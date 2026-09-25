//! Runs `ollama serve` for Radium: start it with the saved settings, keep its
//! log, stop it (with the model runners it spawned), and take over an Ollama
//! the user started themselves.

use std::{
    collections::VecDeque,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri_plugin_http::reqwest;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Child,
    sync::Mutex,
};

use super::{install::Binary, settings::OllamaSettings};

/// Lines of Ollama's own output kept for the Logs panel.
const LOG_LINES: usize = 1000;
/// Loading the server is quick; a first start on a slow disk can take a while.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a stopped Ollama may take to release its port.
const PORT_RELEASE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct LogBuffer {
    lines: VecDeque<String>,
}

impl LogBuffer {
    pub fn push(&mut self, line: String) {
        if self.lines.len() == LOG_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    pub fn tail(&self, count: usize) -> Vec<String> {
        let skip = self.lines.len().saturating_sub(count);
        self.lines.iter().skip(skip).cloned().collect()
    }

    pub fn clear(&mut self) {
        self.lines.clear();
    }
}

pub struct Running {
    pub child: Child,
    pub port: u16,
    pub binary: Binary,
    pub started_at_ms: u64,
}

/// Radium's Ollama, if it runs one. Managed by Tauri.
#[derive(Default)]
pub struct OllamaState {
    pub running: Mutex<Option<Running>>,
    pub logs: Arc<StdMutex<LogBuffer>>,
    pub pulls: StdMutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())
}

/// Ollama's version if something answers `/api/version` at `base_url`.
pub async fn version_at(base_url: &str) -> Option<String> {
    let response = http().ok()?.get(format!("{base_url}/api/version")).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    body.get("version")?.as_str().map(str::to_string)
}

fn keep_output(child: &mut Child, logs: &Arc<StdMutex<LogBuffer>>) {
    fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
        reader: R,
        logs: Arc<StdMutex<LogBuffer>>,
    ) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[ollama] {line}");
                if let Ok(mut buffer) = logs.lock() {
                    buffer.push(line);
                }
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        pump(stdout, Arc::clone(logs));
    }
    if let Some(stderr) = child.stderr.take() {
        pump(stderr, Arc::clone(logs));
    }
}

/// Starts `ollama serve` and waits until it answers. On any failure the
/// process is stopped and the error carries its last log lines.
pub async fn start(
    binary: &Binary,
    settings: &OllamaSettings,
    logs: &Arc<StdMutex<LogBuffer>>,
) -> Result<Running, String> {
    let env = settings.env()?;
    let mut command = tokio::process::Command::new(&binary.path);
    command
        .arg("serve")
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    // Its own process group, so stopping it also stops the model runners it
    // starts.
    #[cfg(unix)]
    command.process_group(0);

    if let Ok(mut buffer) = logs.lock() {
        buffer.clear();
        buffer.push(format!("Starting {} serve", binary.path.display()));
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Ollama ({}): {error}", binary.path.display()))?;
    keep_output(&mut child, logs);

    let base_url = settings.base_url();
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(with_log_tail(
                format!("Ollama stopped while starting ({status})"),
                logs,
            ));
        }
        if version_at(&base_url).await.is_some() {
            return Ok(Running {
                child,
                port: settings.port,
                binary: binary.clone(),
                started_at_ms: now_ms(),
            });
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = stop(&mut child).await;
            return Err(with_log_tail(
                format!("Ollama did not answer on {base_url} within a minute"),
                logs,
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn with_log_tail(message: String, logs: &Arc<StdMutex<LogBuffer>>) -> String {
    let tail = logs
        .lock()
        .map(|buffer| buffer.tail(5).join("\n"))
        .unwrap_or_default();
    if tail.is_empty() {
        message
    } else {
        format!("{message}:\n{tail}")
    }
}

/// Stops Ollama and every runner it started.
pub async fn stop(child: &mut Child) -> Result<(), String> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    let Some(pid) = child.id() else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        // Ask the group nicely first; Ollama unloads models on SIGTERM.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /T takes the runner processes with it.
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(())
}

/// An Ollama process Radium did not start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProcess {
    pub pid: u32,
    pub name: String,
    pub exe: Option<PathBuf>,
}

/// True for Ollama's server/runner (`ollama`, `ollama.exe`) and its Windows
/// tray app (`ollama app.exe`).
pub fn is_ollama_process_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "ollama" | "ollama.exe" | "ollama app.exe" | "ollama app" | "ollama-app"
    )
}

pub fn external_processes(exclude_pid: Option<u32>) -> Vec<ExternalProcess> {
    use sysinfo::{ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let mut found: Vec<ExternalProcess> = system
        .processes()
        .iter()
        .filter(|(pid, _)| Some(pid.as_u32()) != exclude_pid)
        .filter(|(_, process)| is_ollama_process_name(&process.name().to_string_lossy()))
        .map(|(pid, process)| ExternalProcess {
            pid: pid.as_u32(),
            name: process.name().to_string_lossy().into_owned(),
            exe: process.exe().map(PathBuf::from),
        })
        .collect();
    // The tray app first: stopped first, it cannot restart the server.
    found.sort_by_key(|process| !process.name.to_ascii_lowercase().contains("app"));
    found
}

/// The server executable among `processes` (not the tray app), to run it
/// the same way under Radium when Radium has no copy of its own.
pub fn server_exe(processes: &[ExternalProcess]) -> Option<PathBuf> {
    processes
        .iter()
        .filter(|process| !process.name.to_ascii_lowercase().contains("app"))
        .find_map(|process| process.exe.clone())
}

/// Stops the given processes and waits for `port` to be released.
pub async fn stop_external(processes: &[ExternalProcess], port: u16) -> Result<(), String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    for process in processes {
        if let Some(found) = system.process(Pid::from_u32(process.pid)) {
            found.kill();
        }
    }
    let deadline = tokio::time::Instant::now() + PORT_RELEASE_TIMEOUT;
    while !crate::core::runtimes::ports::is_free_on_loopback(port) {
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "Port {port} is still in use after stopping Ollama. Quit Ollama from its tray icon, then try again."
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_keeps_only_the_newest_lines() {
        let mut buffer = LogBuffer::default();
        for index in 0..(LOG_LINES + 10) {
            buffer.push(format!("line {index}"));
        }
        let tail = buffer.tail(3);
        assert_eq!(
            tail,
            [
                format!("line {}", LOG_LINES + 7),
                format!("line {}", LOG_LINES + 8),
                format!("line {}", LOG_LINES + 9)
            ]
        );
        assert_eq!(buffer.tail(usize::MAX).len(), LOG_LINES);
    }

    #[test]
    fn ollama_process_names_include_the_tray_app_and_nothing_else() {
        for name in ["ollama", "ollama.exe", "Ollama.exe", "ollama app.exe", "Ollama App.exe"] {
            assert!(is_ollama_process_name(name), "{name}");
        }
        for name in ["ollama-helper", "llama-server", "radium", "ollamax.exe"] {
            assert!(!is_ollama_process_name(name), "{name}");
        }
    }

    #[test]
    fn the_server_exe_is_found_and_the_tray_app_is_not_used() {
        let processes = vec![
            ExternalProcess {
                pid: 1,
                name: "ollama app.exe".into(),
                exe: Some(PathBuf::from(r"C:\Ollama\ollama app.exe")),
            },
            ExternalProcess {
                pid: 2,
                name: "ollama.exe".into(),
                exe: Some(PathBuf::from(r"C:\Ollama\ollama.exe")),
            },
        ];
        assert_eq!(server_exe(&processes), Some(PathBuf::from(r"C:\Ollama\ollama.exe")));
        assert_eq!(server_exe(&processes[..1]), None);
    }

    /// A stand-in `ollama` that answers `/api/version` like the real one, so
    /// start, readiness, logs and stop are exercised end to end.
    #[cfg(unix)]
    fn fake_ollama(dir: &std::path::Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("ollama");
        std::fs::write(
            &script,
            r#"#!/usr/bin/env python3
import http.server, os, sys
host, port = os.environ["OLLAMA_HOST"].split(":")
print("fake ollama listening on", host, port, "keep_alive", os.environ.get("OLLAMA_KEEP_ALIVE"), flush=True)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"version":"0.34.4"}'
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer((host, int(port)), H).serve_forever()
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn start_waits_until_ollama_answers_keeps_its_log_and_stop_releases_the_port() {
        if std::process::Command::new("python3").arg("--version").output().is_err() {
            return; // no interpreter for the stand-in
        }
        let dir = tempfile::tempdir().unwrap();
        let binary = Binary {
            path: fake_ollama(dir.path()),
            source: super::super::install::BinarySource::System,
        };
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let settings = OllamaSettings {
            port,
            keep_alive: "30m".into(),
            ..OllamaSettings::default()
        };
        let logs = Arc::new(StdMutex::new(LogBuffer::default()));
        let mut running = start(&binary, &settings, &logs).await.unwrap();
        assert_eq!(version_at(&settings.base_url()).await.as_deref(), Some("0.34.4"));
        // Its own output reached the log, with the settings applied.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let log = logs.lock().unwrap().tail(10).join("\n");
        assert!(log.contains("keep_alive 30m"), "{log}");

        stop(&mut running.child).await.unwrap();
        assert!(crate::core::runtimes::ports::is_free_on_loopback(port));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_program_that_exits_at_once_reports_why() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("ollama");
        std::fs::write(&script, "#!/bin/sh\necho 'Error: listen tcp: address already in use' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let binary = Binary {
            path: script,
            source: super::super::install::BinarySource::System,
        };
        let logs = Arc::new(StdMutex::new(LogBuffer::default()));
        let error = start(&binary, &OllamaSettings { port: 39999, ..Default::default() }, &logs)
            .await
            .err()
            .unwrap();
        assert!(error.contains("stopped while starting"), "{error}");
        // Give the pump a moment, then the reason is in the log.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(logs.lock().unwrap().tail(5).join("\n").contains("address already in use"));
    }
}
