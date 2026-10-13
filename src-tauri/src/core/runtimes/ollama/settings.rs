//! Ollama's server settings as Radium stores them, and the environment
//! variables they become when Radium starts `ollama serve`.
//!
//! Ollama reads its server configuration only from environment variables
//! (`envconfig/config.go`), so every setting here maps to one of them. The
//! names and meanings below are Ollama's own; nothing is invented.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// The port Ollama uses unless told otherwise. Radium keeps it, so tools that
/// expect Ollama at 11434 keep working when Radium runs it.
pub const DEFAULT_PORT: u16 = 11434;

/// Radium's own OpenAI server.
const RADIUM_PORT: u16 = 1337;

/// K/V cache types Ollama accepts for `OLLAMA_KV_CACHE_TYPE`.
pub const KV_CACHE_TYPES: [&str; 3] = ["f16", "q8_0", "q4_0"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OllamaSettings {
    /// `OLLAMA_HOST` port.
    pub port: u16,
    /// `OLLAMA_HOST` address: loopback unless the user opens it to the LAN.
    pub allow_network: bool,
    /// `OLLAMA_MODELS`. Empty keeps Ollama's own default (or the user's
    /// existing `OLLAMA_MODELS`), so models already downloaded are reused.
    pub models_dir: String,
    /// `OLLAMA_CONTEXT_LENGTH`. 0 lets Ollama choose from free VRAM.
    pub context_length: u32,
    /// `OLLAMA_KEEP_ALIVE`: how long an idle model stays in memory.
    pub keep_alive: String,
    /// `OLLAMA_FLASH_ATTENTION`.
    pub flash_attention: bool,
    /// `OLLAMA_KV_CACHE_TYPE`. Only applied with flash attention on.
    pub kv_cache_type: String,
    /// `OLLAMA_NUM_PARALLEL`. 0 keeps Ollama's default.
    pub num_parallel: u32,
    /// `OLLAMA_MAX_LOADED_MODELS` (per GPU). 0 keeps Ollama's default.
    pub max_loaded_models: u32,
    /// `CUDA_VISIBLE_DEVICES`, as comma-separated GPU UUIDs. Empty = all GPUs.
    pub gpus: String,
    /// `OLLAMA_SCHED_SPREAD`: always spread a model across every GPU.
    pub spread_across_gpus: bool,
    /// `OLLAMA_GPU_OVERHEAD`, entered in MiB, passed in bytes.
    pub gpu_overhead_mib: u64,
    /// `OLLAMA_NO_CLOUD`: turn off Ollama's cloud models and web search.
    pub no_cloud: bool,
    /// Start Ollama when Radium starts.
    pub auto_start: bool,
    /// Extra `KEY=VALUE` lines, one per line, applied last.
    pub extra_env: String,
}

impl Default for OllamaSettings {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            allow_network: false,
            models_dir: String::new(),
            context_length: 0,
            keep_alive: "5m".into(),
            flash_attention: false,
            kv_cache_type: "f16".into(),
            num_parallel: 0,
            max_loaded_models: 0,
            gpus: String::new(),
            spread_across_gpus: false,
            gpu_overhead_mib: 0,
            no_cloud: false,
            auto_start: false,
            extra_env: String::new(),
        }
    }
}

/// `5m`, `90s`, `1h`, `0` (unload at once) or `-1` (keep forever).
fn is_duration(value: &str) -> bool {
    if value == "0" || value == "-1" {
        return true;
    }
    let Some(unit) = value.chars().last() else {
        return false;
    };
    let number = &value[..value.len() - unit.len_utf8()];
    matches!(unit, 's' | 'm' | 'h')
        && !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit())
}

fn is_env_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !key.starts_with(|c: char| c.is_ascii_digit())
}

/// Parses the extra environment lines. Blank lines and `#` comments are
/// skipped; anything else must be `KEY=VALUE` with an upper-case key.
pub fn parse_extra_env(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("Line {} is not KEY=VALUE: {line}", index + 1))?;
        let key = key.trim();
        if !is_env_key(key) {
            return Err(format!(
                "Line {}: {key:?} is not an environment variable name",
                index + 1
            ));
        }
        pairs.push((key.to_string(), value.trim().to_string()));
    }
    Ok(pairs)
}

impl OllamaSettings {
    /// Refuses settings Ollama would reject or that would break Radium.
    pub fn validate(&self) -> Result<(), String> {
        if self.port < 1024 {
            return Err("Use a port from 1024 to 65535".into());
        }
        if self.port == RADIUM_PORT {
            return Err("Port 1337 is Radium's own server; pick another".into());
        }
        if !self.keep_alive.is_empty() && !is_duration(&self.keep_alive) {
            return Err(format!(
                "Keep-alive {:?} must look like 5m, 90s, 1h, 0 or -1",
                self.keep_alive
            ));
        }
        if !KV_CACHE_TYPES.contains(&self.kv_cache_type.as_str()) {
            return Err(format!(
                "K/V cache type must be one of {}",
                KV_CACHE_TYPES.join(", ")
            ));
        }
        if self.context_length > 1_048_576 {
            return Err("Context length above 1,048,576 tokens is not supported".into());
        }
        if !self.models_dir.trim().is_empty() && !Path::new(self.models_dir.trim()).is_absolute()
        {
            return Err("The models folder must be a full path".into());
        }
        for uuid in self.gpu_list() {
            if !uuid
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return Err(format!("{uuid:?} is not a GPU id"));
            }
        }
        parse_extra_env(&self.extra_env).map(|_| ())
    }

    fn gpu_list(&self) -> Vec<String> {
        self.gpus
            .split(',')
            .map(str::trim)
            .filter(|uuid| !uuid.is_empty())
            .map(|uuid| {
                if uuid.starts_with("GPU-") || uuid.chars().all(|c| c.is_ascii_digit()) {
                    uuid.to_string()
                } else {
                    format!("GPU-{uuid}")
                }
            })
            .collect()
    }

    /// The address Radium talks to, always on loopback.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The environment `ollama serve` is started with. Only settings that
    /// differ from Ollama's defaults are set, so a variable the user set in
    /// Windows still applies unless Radium's setting overrides it.
    pub fn env(&self) -> Result<Vec<(String, String)>, String> {
        let mut env = Vec::new();
        let host = if self.allow_network { "0.0.0.0" } else { "127.0.0.1" };
        env.push(("OLLAMA_HOST".into(), format!("{host}:{}", self.port)));
        let models_dir = self.models_dir.trim();
        if !models_dir.is_empty() {
            env.push(("OLLAMA_MODELS".into(), models_dir.to_string()));
        }
        if self.context_length > 0 {
            env.push(("OLLAMA_CONTEXT_LENGTH".into(), self.context_length.to_string()));
        }
        if !self.keep_alive.is_empty() {
            env.push(("OLLAMA_KEEP_ALIVE".into(), self.keep_alive.clone()));
        }
        if self.flash_attention {
            env.push(("OLLAMA_FLASH_ATTENTION".into(), "1".into()));
            // Ollama ignores a quantized K/V cache without flash attention.
            if self.kv_cache_type != "f16" {
                env.push(("OLLAMA_KV_CACHE_TYPE".into(), self.kv_cache_type.clone()));
            }
        }
        if self.num_parallel > 0 {
            env.push(("OLLAMA_NUM_PARALLEL".into(), self.num_parallel.to_string()));
        }
        if self.max_loaded_models > 0 {
            env.push((
                "OLLAMA_MAX_LOADED_MODELS".into(),
                self.max_loaded_models.to_string(),
            ));
        }
        let gpus = self.gpu_list();
        if !gpus.is_empty() {
            env.push(("CUDA_DEVICE_ORDER".into(), "PCI_BUS_ID".into()));
            env.push(("CUDA_VISIBLE_DEVICES".into(), gpus.join(",")));
        }
        if self.spread_across_gpus {
            env.push(("OLLAMA_SCHED_SPREAD".into(), "1".into()));
        }
        if self.gpu_overhead_mib > 0 {
            env.push((
                "OLLAMA_GPU_OVERHEAD".into(),
                (self.gpu_overhead_mib * 1024 * 1024).to_string(),
            ));
        }
        if self.no_cloud {
            env.push(("OLLAMA_NO_CLOUD".into(), "1".into()));
        }
        // Extra lines win: they are the escape hatch for anything above.
        for (key, value) in parse_extra_env(&self.extra_env)? {
            env.retain(|(existing, _)| *existing != key);
            env.push((key, value));
        }
        Ok(env)
    }

    /// Whether changing from `self` to `next` needs Ollama restarted: every
    /// field is read once at start, except auto-start.
    pub fn needs_restart(&self, next: &OllamaSettings) -> bool {
        let mut a = self.clone();
        let mut b = next.clone();
        a.auto_start = false;
        b.auto_start = false;
        a != b
    }
}

/// Reads saved settings, falling back to defaults for a missing or damaged
/// file (a damaged file is logged, never fatal: Ollama must still start).
pub fn load(path: &Path) -> OllamaSettings {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
            log::warn!("[ollama] settings at {} unreadable: {error}", path.display());
            OllamaSettings::default()
        }),
        Err(_) => OllamaSettings::default(),
    }
}

pub fn save(path: &Path, settings: &OllamaSettings) -> Result<(), String> {
    settings.validate()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    // Write then rename, so a crash mid-write never leaves half a file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_map(settings: &OllamaSettings) -> std::collections::HashMap<String, String> {
        settings.env().unwrap().into_iter().collect()
    }

    #[test]
    fn defaults_only_set_the_address_and_keep_alive() {
        let env = env_map(&OllamaSettings::default());
        assert_eq!(env.get("OLLAMA_HOST").unwrap(), "127.0.0.1:11434");
        assert_eq!(env.get("OLLAMA_KEEP_ALIVE").unwrap(), "5m");
        assert_eq!(env.len(), 2, "{env:?}");
        assert!(OllamaSettings::default().validate().is_ok());
    }

    #[test]
    fn every_setting_maps_to_ollamas_own_variable() {
        let settings = OllamaSettings {
            port: 11500,
            allow_network: true,
            models_dir: if cfg!(windows) { r"D:\ollama\models".into() } else { "/data/ollama".into() },
            context_length: 32768,
            keep_alive: "30m".into(),
            flash_attention: true,
            kv_cache_type: "q8_0".into(),
            num_parallel: 4,
            max_loaded_models: 2,
            gpus: "aaaa-1111, GPU-bbbb-2222".into(),
            spread_across_gpus: true,
            gpu_overhead_mib: 512,
            no_cloud: true,
            auto_start: true,
            extra_env: String::new(),
        };
        settings.validate().unwrap();
        let env = env_map(&settings);
        assert_eq!(env["OLLAMA_HOST"], "0.0.0.0:11500");
        assert!(env["OLLAMA_MODELS"].ends_with("ollama") || env["OLLAMA_MODELS"].ends_with("models"));
        assert_eq!(env["OLLAMA_CONTEXT_LENGTH"], "32768");
        assert_eq!(env["OLLAMA_KEEP_ALIVE"], "30m");
        assert_eq!(env["OLLAMA_FLASH_ATTENTION"], "1");
        assert_eq!(env["OLLAMA_KV_CACHE_TYPE"], "q8_0");
        assert_eq!(env["OLLAMA_NUM_PARALLEL"], "4");
        assert_eq!(env["OLLAMA_MAX_LOADED_MODELS"], "2");
        assert_eq!(env["CUDA_VISIBLE_DEVICES"], "GPU-aaaa-1111,GPU-bbbb-2222");
        assert_eq!(env["CUDA_DEVICE_ORDER"], "PCI_BUS_ID");
        assert_eq!(env["OLLAMA_SCHED_SPREAD"], "1");
        assert_eq!(env["OLLAMA_GPU_OVERHEAD"], (512u64 * 1024 * 1024).to_string());
        assert_eq!(env["OLLAMA_NO_CLOUD"], "1");
    }

    #[test]
    fn a_quantized_kv_cache_needs_flash_attention() {
        let settings = OllamaSettings {
            kv_cache_type: "q4_0".into(),
            ..OllamaSettings::default()
        };
        assert!(!env_map(&settings).contains_key("OLLAMA_KV_CACHE_TYPE"));
    }

    #[test]
    fn extra_lines_are_applied_last_and_win() {
        let settings = OllamaSettings {
            extra_env: "# comment\n\nOLLAMA_KEEP_ALIVE=-1\nOLLAMA_DEBUG=1\n".into(),
            ..OllamaSettings::default()
        };
        let env = settings.env().unwrap();
        assert_eq!(env.iter().filter(|(k, _)| k == "OLLAMA_KEEP_ALIVE").count(), 1);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(map["OLLAMA_KEEP_ALIVE"], "-1");
        assert_eq!(map["OLLAMA_DEBUG"], "1");
    }

    #[test]
    fn bad_values_are_refused_with_a_reason() {
        let bad = |settings: OllamaSettings| settings.validate().unwrap_err();
        assert!(bad(OllamaSettings { port: 1337, ..Default::default() }).contains("1337"));
        assert!(bad(OllamaSettings { port: 80, ..Default::default() }).contains("1024"));
        assert!(bad(OllamaSettings { keep_alive: "5 minutes".into(), ..Default::default() })
            .contains("5m"));
        assert!(bad(OllamaSettings { kv_cache_type: "q2".into(), ..Default::default() })
            .contains("f16"));
        assert!(bad(OllamaSettings { models_dir: "models".into(), ..Default::default() })
            .contains("full path"));
        assert!(bad(OllamaSettings { gpus: "GPU-1; rm".into(), ..Default::default() })
            .contains("GPU id"));
        assert!(bad(OllamaSettings { extra_env: "lower=1".into(), ..Default::default() })
            .contains("Line 1"));
        assert!(bad(OllamaSettings { extra_env: "NOEQUALS".into(), ..Default::default() })
            .contains("KEY=VALUE"));
    }

    #[test]
    fn durations_ollama_accepts() {
        for ok in ["5m", "90s", "1h", "0", "-1", "24h"] {
            assert!(is_duration(ok), "{ok}");
        }
        for bad in ["", "m", "5", "5d", "1.5h", "-2"] {
            assert!(!is_duration(bad), "{bad}");
        }
    }

    #[test]
    fn only_auto_start_changes_without_a_restart() {
        let base = OllamaSettings::default();
        let auto = OllamaSettings { auto_start: true, ..base.clone() };
        let ctx = OllamaSettings { context_length: 8192, ..base.clone() };
        assert!(!base.needs_restart(&auto));
        assert!(base.needs_restart(&ctx));
    }

    #[test]
    fn settings_round_trip_and_a_damaged_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("runtimes/ollama/settings.json");
        let settings = OllamaSettings { context_length: 16384, ..Default::default() };
        save(&path, &settings).unwrap();
        assert_eq!(load(&path), settings);

        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(load(&path), OllamaSettings::default());

        // Older files without newer fields still load.
        std::fs::write(&path, r#"{"port": 11500}"#).unwrap();
        assert_eq!(load(&path).port, 11500);
        assert_eq!(load(&path).keep_alive, "5m");
    }

    #[test]
    fn invalid_settings_are_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(save(&path, &OllamaSettings { port: 1337, ..Default::default() }).is_err());
        assert!(!path.exists());
    }
}
