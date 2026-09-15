//! Starts, watches and stops the built-in engine's server (tracker Task 30 S05,
//! part 2).
//!
//! Follows the llama.cpp server's proven pattern: start the program with its
//! output captured, count it as ready once its address answers, report it if
//! it exits early or never becomes ready, and always stop it again. Step
//! progress is read from the engine's output, because its job API reports only
//! the job's status and queue position.

use std::{path::Path, process::Stdio, time::Duration};

use tauri_plugin_http::reqwest;
use tokio::{io::AsyncReadExt, process::Child};

/// How often the ready address is checked while the engine starts.
const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Step progress in one chunk of the engine's output, such as
/// `|=====>      | 3/20 - 3.38s/it`. A chunk can hold several updates; the
/// last one wins. `None` when the chunk has no progress bar.
pub fn parse_progress(chunk: &str) -> Option<(u32, u32)> {
    let mut latest = None;
    // Updates are separated by carriage returns, line breaks or the terminal
    // escape that clears the line.
    for piece in chunk.split(['\r', '\n', '\u{1b}']) {
        let Some(bar_end) = piece.rfind('|') else {
            continue;
        };
        // A progress bar has an opening `|` before the closing one.
        if !piece[..bar_end].contains('|') {
            continue;
        }
        let counts = piece[bar_end + 1..].split_whitespace().next().unwrap_or("");
        let Some((current, total)) = counts.split_once('/') else {
            continue;
        };
        if let (Ok(current), Ok(total)) = (current.parse::<u32>(), total.parse::<u32>()) {
            if total > 0 && current <= total {
                latest = Some((current, total));
            }
        }
    }
    latest
}

/// Starts `program` with `args`, then waits until `ready_url` answers with
/// success, the program exits, or `timeout` passes. On any failure the
/// program is stopped before the error is returned.
pub async fn start_server(
    program: &Path,
    args: &[String],
    ready_url: &str,
    timeout: Duration,
) -> Result<Child, String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Stopped automatically if Radium lets go of it.
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window
    let mut child = command.spawn().map_err(|error| {
        format!(
            "The media engine could not start ({}): {error}",
            program.display()
        )
    })?;
    drain_output(&mut child);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| format!("Could not check the media engine: {error}"))?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "The media engine exited before it was ready ({status})"
                ));
            }
            Ok(None) => {}
            Err(error) => {
                let _ = stop_server(&mut child).await;
                return Err(format!("Could not watch the media engine: {error}"));
            }
        }
        if let Ok(response) = client.get(ready_url).send().await {
            if response.status().is_success() {
                return Ok(child);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = stop_server(&mut child).await;
            return Err(format!(
                "The media engine did not become ready within {} seconds",
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

/// Stops the server and waits until it has gone.
pub async fn stop_server(child: &mut Child) -> Result<(), String> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    child
        .kill()
        .await
        .map_err(|error| format!("Could not stop the media engine: {error}"))
}

/// Reads the engine's output so it never blocks on a full pipe, and logs it.
fn drain_output(child: &mut Child) {
    if let Some(mut stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let mut buffer = [0_u8; 4096];
            while let Ok(read) = stdout.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                log::debug!(
                    "media engine: {}",
                    String::from_utf8_lossy(&buffer[..read]).trim_end()
                );
            }
        });
    }
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut buffer = [0_u8; 4096];
            while let Ok(read) = stderr.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                log::debug!(
                    "media engine: {}",
                    String::from_utf8_lossy(&buffer[..read]).trim_end()
                );
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Instant;

    /// A program that exits straight away with code 3.
    fn exits_with_3() -> (&'static Path, Vec<String>) {
        if cfg!(windows) {
            (Path::new("cmd"), vec!["/C".into(), "exit 3".into()])
        } else {
            (Path::new("sh"), vec!["-c".into(), "exit 3".into()])
        }
    }

    /// A program that keeps running for about 30 seconds.
    fn keeps_running() -> (&'static Path, Vec<String>) {
        if cfg!(windows) {
            (
                Path::new("cmd"),
                vec!["/C".into(), "ping -n 30 127.0.0.1 >NUL".into()],
            )
        } else {
            (Path::new("sh"), vec!["-c".into(), "sleep 30".into()])
        }
    }

    /// A port nothing is listening on.
    fn unused_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    /// A tiny stand-in for the engine's API that answers every request with 200.
    fn answering_server() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                );
            }
        });
        port
    }

    #[test]
    fn progress_is_read_from_the_engines_progress_bar() {
        assert_eq!(
            parse_progress(
                "  |==>                                               | 1/20 - 6.96s/it"
            ),
            Some((1, 20))
        );
        // Several updates in one chunk, as the engine writes them on one line.
        assert_eq!(
            parse_progress(
                "  |==>    | 1/20 - 6.96s/it\u{1b}[K  |=====>   | 2/20 - 3.35s/it\u{1b}[K\r  |=======> | 3/20 - 3.38s/it"
            ),
            Some((3, 20))
        );
        assert_eq!(
            parse_progress("[INFO   ] image.cpp:886  - sampling completed, taking 73.37s"),
            None
        );
        // Numbers with a slash are not progress without the bar.
        assert_eq!(parse_progress("loaded 3/4 tensors"), None);
    }

    #[tokio::test]
    async fn an_engine_that_exits_at_once_is_reported_with_its_exit_code() {
        let (program, args) = exits_with_3();
        let started = Instant::now();

        let error = start_server(
            program,
            &args,
            &format!("http://127.0.0.1:{}/sdcpp/v1/capabilities", unused_port()),
            Duration::from_secs(20),
        )
        .await
        .unwrap_err();

        assert!(error.contains("exited"), "{error}");
        assert!(error.contains('3'), "{error}");
        // Reported as soon as it exits, not after the full wait.
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn the_server_is_ready_once_its_address_answers_and_can_be_stopped() {
        let (program, args) = keeps_running();
        let port = answering_server();

        let mut child = start_server(
            program,
            &args,
            &format!("http://127.0.0.1:{port}/sdcpp/v1/capabilities"),
            Duration::from_secs(20),
        )
        .await
        .expect("ready once the address answers");
        assert!(child.try_wait().unwrap().is_none(), "still running");

        stop_server(&mut child).await.unwrap();

        assert!(child.try_wait().unwrap().is_some(), "stopped");
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out() {
        let (program, args) = keeps_running();

        let error = start_server(
            program,
            &args,
            &format!("http://127.0.0.1:{}/sdcpp/v1/capabilities", unused_port()),
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();

        assert!(error.contains("did not become ready"), "{error}");
    }
}
