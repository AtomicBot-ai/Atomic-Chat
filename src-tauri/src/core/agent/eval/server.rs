use std::fs::File;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct LlamaServerConfig {
    pub executable: PathBuf,
    pub model: PathBuf,
    pub mmproj: Option<PathBuf>,
    pub context_size: u32,
    pub gpu_layers: i32,
    pub startup_timeout: Duration,
    pub extra_args: Vec<String>,
}

pub struct DedicatedLlamaServer {
    child: Child,
    port: u16,
    stdout_log: PathBuf,
    stderr_log: PathBuf,
}

impl DedicatedLlamaServer {
    pub async fn start(config: &LlamaServerConfig, log_dir: &Path) -> Result<Self, String> {
        validate_config(config)?;
        std::fs::create_dir_all(log_dir)
            .map_err(|error| format!("Failed to create server log directory: {error}"))?;
        let port = reserve_loopback_port()?;
        let stdout_log = log_dir.join("llama-server.stdout.log");
        let stderr_log = log_dir.join("llama-server.stderr.log");
        let stdout = File::create(&stdout_log)
            .map_err(|error| format!("Failed to create llama-server stdout log: {error}"))?;
        let stderr = File::create(&stderr_log)
            .map_err(|error| format!("Failed to create llama-server stderr log: {error}"))?;
        let mut command = Command::new(&config.executable);
        command.args([
            "--model",
            &config.model.to_string_lossy(),
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--parallel",
            "1",
            "--ctx-size",
            &config.context_size.to_string(),
            "--no-webui",
            "--jinja",
            "-ngl",
            &config.gpu_layers.to_string(),
        ]);
        if let Some(mmproj) = &config.mmproj {
            command.args(["--mmproj", &mmproj.to_string_lossy()]);
        }
        command
            .args(&config.extra_args)
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        let child = command.spawn().map_err(|error| {
            format!(
                "Failed to start llama-server at {}: {error}",
                config.executable.display()
            )
        })?;
        let mut server = Self {
            child,
            port,
            stdout_log,
            stderr_log,
        };
        if let Err(error) = server.wait_for_health(config.startup_timeout).await {
            return Err(format!("{error}\n{}", server.diagnostics()));
        }
        Ok(server)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn diagnostics(&mut self) -> String {
        let status = self.child.try_wait().ok().flatten();
        format!(
            "process_status={status:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
            read_log_tail(&self.stdout_log),
            read_log_tail(&self.stderr_log)
        )
    }

    async fn wait_for_health(&mut self, timeout: Duration) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|error| format!("Failed to build health client: {error}"))?;
        let health_url = format!("http://127.0.0.1:{}/health", self.port);
        let started = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
                return Err(format!("llama-server exited before readiness: {status}"));
            }
            if let Ok(response) = client.get(&health_url).send().await {
                if response.status().is_success() {
                    return Ok(());
                }
            }
            if started.elapsed() >= timeout {
                return Err(format!(
                    "llama-server health check timed out after {timeout:?}"
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

impl Drop for DedicatedLlamaServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn validate_config(config: &LlamaServerConfig) -> Result<(), String> {
    if !config.executable.is_file() {
        return Err(format!(
            "llama-server is not a file: {}",
            config.executable.display()
        ));
    }
    if !config.model.is_file() {
        return Err(format!(
            "GGUF model is not a file: {}",
            config.model.display()
        ));
    }
    if let Some(mmproj) = &config.mmproj {
        if !mmproj.is_file() {
            return Err(format!("mmproj is not a file: {}", mmproj.display()));
        }
    }
    Ok(())
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Failed to reserve loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Failed to read reserved loopback port: {error}"))
}

fn read_log_tail(path: &Path) -> String {
    const MAX_LOG_CHARS: usize = 20_000;
    let Ok(content) = std::fs::read_to_string(path) else {
        return "<unavailable>".into();
    };
    let chars = content.chars().collect::<Vec<_>>();
    chars[chars.len().saturating_sub(MAX_LOG_CHARS)..]
        .iter()
        .collect()
}
