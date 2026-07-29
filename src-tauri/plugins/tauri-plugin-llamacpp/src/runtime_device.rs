use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Which device the loaded model actually runs on, derived from the
/// llama-server startup log.
///
/// `--list-devices` only reports what a binary can *enumerate*; it says nothing
/// about the device the loaded model ended up on, and it is known to return an
/// empty list on hosts where inference still runs on the GPU. The startup log
/// of the loaded process is the only signal that reflects reality, so a
/// CUDA/Vulkan build that silently degraded to CPU (missing cudart, parked
/// dGPU, driver/ABI mismatch) can be told apart from a healthy GPU load.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuntimeDeviceInfo {
    /// Backend libraries the process loaded, in load order: `CUDA`, `Vulkan`,
    /// `Metal`, `RPC`, `CPU`, ...
    pub loaded_backends: Vec<String>,
    /// Buffer label of the device holding most of the model weights
    /// (`CUDA0`, `Vulkan0`, `Metal`, `CPU`, ...). Empty when undetermined.
    pub primary_device: String,
    pub gpu_layers_offloaded: Option<i32>,
    pub total_layers: Option<i32>,
    pub gpu_buffer_bytes: Option<u64>,
    /// The binary links against a CUDA runtime that was not found on this host.
    /// Separates a fixable "install the CUDA runtime" case from a GPU that the
    /// loaded backend simply could not use.
    pub cuda_runtime_missing: bool,
    /// First device-initialisation failure the backend reported, verbatim.
    pub device_init_error: Option<String>,
}

/// Accumulates the startup log line by line. Fed from the stdout/stderr reader
/// tasks that already stream every line of the spawned process.
#[derive(Debug, Default)]
pub struct RuntimeDeviceAccumulator {
    loaded_backends: Vec<String>,
    buffers: HashMap<String, u64>,
    gpu_layers_offloaded: Option<i32>,
    total_layers: Option<i32>,
    cuda_runtime_missing: bool,
    device_init_error: Option<String>,
}

impl RuntimeDeviceAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Recorded at spawn time from the existing `add_cuda_paths` /
    /// `binary_requires_cuda` probe, which knows this before any log line.
    pub fn mark_cuda_runtime_missing(&mut self) {
        self.cuda_runtime_missing = true;
    }

    pub fn ingest(&mut self, line: &str) {
        if self.device_init_error.is_none() {
            if let Some(error) = parse_device_init_error(line) {
                self.device_init_error = Some(error);
            }
        }

        if let Some(backend) = parse_loaded_backend(line) {
            if !self.loaded_backends.iter().any(|b| b == &backend) {
                self.loaded_backends.push(backend);
            }
            return;
        }

        if let Some((offloaded, total)) = parse_offloaded_layers(line) {
            self.gpu_layers_offloaded = Some(offloaded);
            self.total_layers = Some(total);
            return;
        }

        // Printed before the `offloaded N/M` summary and only counts repeating
        // layers, so it is a lower bound used until the summary arrives.
        if let Some(repeating) = parse_repeating_layers(line) {
            if self.gpu_layers_offloaded.is_none() {
                self.gpu_layers_offloaded = Some(repeating);
            }
            return;
        }

        if let Some((label, bytes)) = parse_model_buffer(line) {
            // Multi-GPU splits print one line per device; a device can also be
            // printed more than once across load phases.
            let entry = self.buffers.entry(label).or_insert(0);
            *entry = (*entry).max(bytes);
        }
    }

    pub fn snapshot(&self) -> RuntimeDeviceInfo {
        let gpu_buffers: Vec<(&String, &u64)> = self
            .buffers
            .iter()
            .filter(|(label, _)| !is_cpu_buffer_label(label))
            .collect();

        let largest_gpu = gpu_buffers
            .iter()
            .filter(|(_, bytes)| **bytes > 0)
            // Tie-break on the label so a split across identical buffers is
            // still reported deterministically.
            .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)));

        let nothing_offloaded = self.gpu_layers_offloaded == Some(0);

        let primary_device = match largest_gpu {
            Some((label, _)) if !nothing_offloaded => (*label).clone(),
            _ if !self.buffers.is_empty() => "CPU".to_string(),
            _ => String::new(),
        };

        RuntimeDeviceInfo {
            loaded_backends: self.loaded_backends.clone(),
            primary_device,
            gpu_layers_offloaded: self.gpu_layers_offloaded,
            total_layers: self.total_layers,
            gpu_buffer_bytes: largest_gpu.map(|(_, bytes)| **bytes),
            cuda_runtime_missing: self.cuda_runtime_missing,
            device_init_error: self.device_init_error.clone(),
        }
    }
}

/// Device-initialisation failures that explain why a GPU build ended up on the
/// CPU. Kept to the wordings llama.cpp / the dynamic loader actually emit.
fn parse_device_init_error(line: &str) -> Option<String> {
    const MARKERS: [&str; 6] = [
        "failed to initialize CUDA",
        "no CUDA devices found",
        "error while loading shared libraries",
        "failed to load backend",
        "ggml_vulkan: No devices found",
        "no usable GPU found",
    ];
    let trimmed = line.trim();
    MARKERS
        .iter()
        .any(|marker| trimmed.contains(marker))
        .then(|| trimmed.to_string())
}

impl RuntimeDeviceInfo {
    /// True when the log carried nothing recognisable, so callers must not
    /// conclude anything about the device from it.
    pub fn is_inconclusive(&self) -> bool {
        self.loaded_backends.is_empty()
            && self.primary_device.is_empty()
            && self.gpu_layers_offloaded.is_none()
            && !self.cuda_runtime_missing
            && self.device_init_error.is_none()
    }
}

/// Shared between the stdout and stderr reader tasks (llama.cpp splits the
/// startup log across both) and the session that outlives them.
pub type SharedRuntimeDevice = Arc<Mutex<RuntimeDeviceAccumulator>>;

pub fn new_shared() -> SharedRuntimeDevice {
    Arc::new(Mutex::new(RuntimeDeviceAccumulator::new()))
}

/// A poisoned lock must never break log streaming or a model load, so both
/// helpers degrade to a no-op / empty snapshot instead of propagating.
pub fn ingest_line(shared: &SharedRuntimeDevice, line: &str) {
    if let Ok(mut acc) = shared.lock() {
        acc.ingest(line);
    }
}

pub fn mark_cuda_runtime_missing(shared: &SharedRuntimeDevice) {
    if let Ok(mut acc) = shared.lock() {
        acc.mark_cuda_runtime_missing();
    }
}

pub fn snapshot(shared: &SharedRuntimeDevice) -> RuntimeDeviceInfo {
    shared.lock().map(|acc| acc.snapshot()).unwrap_or_default()
}

fn is_cpu_buffer_label(label: &str) -> bool {
    // `CPU`, `CPU_Mapped`, `CPU_AARCH64`, `CPU_REPACK`
    label == "CPU" || label.starts_with("CPU_")
}

/// `load_backend: loaded CUDA backend from /path/libggml-cuda.so`
fn parse_loaded_backend(line: &str) -> Option<String> {
    let rest = line.split_once("load_backend: loaded ")?.1;
    let name = rest.split_once(" backend")?.0.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

/// `load_tensors: offloaded 33/33 layers to GPU`
/// (older builds use the `llm_load_tensors:` prefix)
fn parse_offloaded_layers(line: &str) -> Option<(i32, i32)> {
    if !line.contains("layers to GPU") {
        return None;
    }
    let rest = line.split_once("offloaded ")?.1;
    let ratio = rest.split_whitespace().next()?;
    let (offloaded, total) = ratio.split_once('/')?;
    Some((offloaded.trim().parse().ok()?, total.trim().parse().ok()?))
}

/// `load_tensors: offloading 32 repeating layers to GPU`
fn parse_repeating_layers(line: &str) -> Option<i32> {
    if !line.contains("repeating layers to GPU") {
        return None;
    }
    let rest = line.split_once("offloading ")?.1;
    rest.split_whitespace().next()?.parse().ok()
}

/// `load_tensors:        CUDA0 model buffer size =  4155.99 MiB`
fn parse_model_buffer(line: &str) -> Option<(String, u64)> {
    let (head, tail) = line.split_once(" model buffer size =")?;
    if !head.contains("load_tensors:") {
        return None;
    }
    let label = head.rsplit_once(':')?.1.trim();
    if label.is_empty() {
        return None;
    }
    Some((label.to_string(), parse_size(tail)?))
}

fn parse_size(text: &str) -> Option<u64> {
    let mut parts = text.split_whitespace();
    let value: f64 = parts.next()?.parse().ok()?;
    let multiplier: f64 = match parts.next().unwrap_or("B") {
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "KiB" => 1024.0,
        _ => 1.0,
    };
    if value < 0.0 {
        return None;
    }
    Some((value * multiplier) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ingest_all(log: &str) -> RuntimeDeviceInfo {
        let mut acc = RuntimeDeviceAccumulator::new();
        for line in log.lines() {
            acc.ingest(line.trim_end());
        }
        acc.snapshot()
    }

    #[test]
    fn healthy_cuda_load() {
        let log = r#"
load_backend: loaded CUDA backend from C:\backends\build\bin\ggml-cuda.dll
load_backend: loaded CPU backend from C:\backends\build\bin\ggml-cpu-haswell.dll
ggml_cuda_init: found 1 CUDA devices:
  Device 0: NVIDIA GeForce RTX 4090, compute capability 8.9, VMM: yes
load_tensors: offloading 32 repeating layers to GPU
load_tensors: offloading output layer to GPU
load_tensors: offloaded 33/33 layers to GPU
load_tensors:        CUDA0 model buffer size =  4155.99 MiB
load_tensors:   CPU_Mapped model buffer size =   308.23 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.loaded_backends, vec!["CUDA", "CPU"]);
        assert_eq!(info.primary_device, "CUDA0");
        assert_eq!(info.gpu_layers_offloaded, Some(33));
        assert_eq!(info.total_layers, Some(33));
        assert_eq!(
            info.gpu_buffer_bytes,
            Some((4155.99_f64 * 1024.0 * 1024.0) as u64)
        );
    }

    #[test]
    fn cuda_binary_that_silently_degraded_to_cpu() {
        // The CUDA library never loads (missing cudart / parked dGPU), so the
        // whole model lands in a CPU buffer even though a CUDA build was picked.
        let log = r#"
load_backend: loaded CPU backend from C:\backends\build\bin\ggml-cpu-haswell.dll
load_tensors: offloaded 0/33 layers to GPU
load_tensors:   CPU_Mapped model buffer size =  4464.22 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.loaded_backends, vec!["CPU"]);
        assert_eq!(info.primary_device, "CPU");
        assert_eq!(info.gpu_layers_offloaded, Some(0));
        assert_eq!(info.total_layers, Some(33));
        assert_eq!(info.gpu_buffer_bytes, None);
    }

    #[test]
    fn cuda_library_loads_but_no_layers_offloaded() {
        // ggml-cuda.dll loads and even prints a device buffer for the KV cache,
        // yet 0 layers are offloaded — still a CPU run.
        let log = r#"
load_backend: loaded CUDA backend from C:\backends\build\bin\ggml-cuda.dll
load_tensors: offloaded 0/33 layers to GPU
load_tensors:        CUDA0 model buffer size =     0.00 MiB
load_tensors:   CPU_Mapped model buffer size =  4464.22 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.primary_device, "CPU");
        assert_eq!(info.gpu_layers_offloaded, Some(0));
    }

    #[test]
    fn vulkan_load() {
        let log = r#"
load_backend: loaded Vulkan backend from /usr/lib/libggml-vulkan.so
ggml_vulkan: Found 1 Vulkan devices:
ggml_vulkan: 0 = AMD Radeon RX 7900 XTX (RADV NAVI31)
load_tensors: offloaded 33/33 layers to GPU
load_tensors:      Vulkan0 model buffer size =  3820.94 MiB
load_tensors:          CPU model buffer size =   102.64 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.loaded_backends, vec!["Vulkan"]);
        assert_eq!(info.primary_device, "Vulkan0");
        assert_eq!(info.gpu_layers_offloaded, Some(33));
    }

    #[test]
    fn metal_load() {
        let log = r#"
load_backend: loaded Metal backend from /Applications/build/bin/libggml-metal.dylib
load_tensors: offloaded 29/29 layers to GPU
load_tensors:        Metal model buffer size =  4155.99 MiB
load_tensors:          CPU model buffer size =   308.23 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.primary_device, "Metal");
        assert_eq!(info.total_layers, Some(29));
    }

    #[test]
    fn cpu_only_build() {
        let log = r#"
load_backend: loaded CPU backend from /usr/lib/libggml-cpu-haswell.so
load_tensors:   CPU_Mapped model buffer size =  4464.22 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.primary_device, "CPU");
        assert_eq!(info.gpu_layers_offloaded, None);
        assert_eq!(info.total_layers, None);
    }

    #[test]
    fn multi_gpu_split_reports_largest_share() {
        let log = r#"
load_backend: loaded CUDA backend from /usr/lib/libggml-cuda.so
load_tensors: offloaded 33/33 layers to GPU
load_tensors:        CUDA0 model buffer size =  1024.00 MiB
load_tensors:        CUDA1 model buffer size =  3072.00 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.primary_device, "CUDA1");
        assert_eq!(info.gpu_buffer_bytes, Some(3 * 1024 * 1024 * 1024));
    }

    #[test]
    fn legacy_llm_load_tensors_prefix() {
        let log = r#"
llm_load_tensors: offloaded 33/33 layers to GPU
llm_load_tensors:      CUDA0 model buffer size =  4155.99 MiB
"#;
        let info = ingest_all(log);
        assert_eq!(info.primary_device, "CUDA0");
        assert_eq!(info.gpu_layers_offloaded, Some(33));
    }

    #[test]
    fn repeating_layers_only() {
        let log = "load_tensors: offloading 32 repeating layers to GPU";
        let info = ingest_all(log);
        assert_eq!(info.gpu_layers_offloaded, Some(32));
        assert_eq!(info.total_layers, None);
        assert_eq!(info.primary_device, "");
    }

    #[test]
    fn unrelated_lines_are_ignored() {
        let log = r#"
main: server is listening on http://127.0.0.1:8080
srv    load_model: loading model
print_info: file size = 4.36 GiB (4.83 BPW)
"#;
        let info = ingest_all(log);
        assert!(info.loaded_backends.is_empty());
        assert_eq!(info.primary_device, "");
        assert_eq!(info.gpu_buffer_bytes, None);
    }

    #[test]
    fn missing_cuda_runtime_is_recorded_and_conclusive() {
        let mut acc = RuntimeDeviceAccumulator::new();
        acc.mark_cuda_runtime_missing();
        let info = acc.snapshot();
        assert!(info.cuda_runtime_missing);
        assert!(!info.is_inconclusive());
    }

    #[test]
    fn device_init_error_captures_first_failure() {
        // The janhq/jan#7121 repro: the CUDA build cannot resolve libcudart.
        let log = r#"
/home/u/.local/share/Jan/data/llamacpp/backends/b7261/linux-cuda-x64/build/bin/llama-server: error while loading shared libraries: libcudart.so.12: cannot open shared object file: No such file or directory
ggml_cuda_init: failed to initialize CUDA: unknown error
"#;
        let info = ingest_all(log);
        assert!(info
            .device_init_error
            .as_deref()
            .unwrap()
            .contains("libcudart.so.12"));
        assert!(!info.is_inconclusive());
    }

    #[test]
    fn healthy_load_reports_no_failure() {
        let log = r#"
load_backend: loaded CUDA backend from /usr/lib/libggml-cuda.so
load_tensors: offloaded 33/33 layers to GPU
load_tensors:        CUDA0 model buffer size =  4155.99 MiB
"#;
        let info = ingest_all(log);
        assert!(!info.cuda_runtime_missing);
        assert_eq!(info.device_init_error, None);
    }

    #[test]
    fn parse_size_units() {
        assert_eq!(parse_size(" 1.00 GiB"), Some(1024 * 1024 * 1024));
        assert_eq!(parse_size("  512.00 MiB"), Some(512 * 1024 * 1024));
        assert_eq!(parse_size("  2.00 KiB"), Some(2048));
        assert_eq!(parse_size("  4096"), Some(4096));
        assert_eq!(parse_size("  not-a-number MiB"), None);
    }

    #[test]
    fn parse_loaded_backend_variants() {
        assert_eq!(
            parse_loaded_backend("load_backend: loaded RPC backend from x.so").as_deref(),
            Some("RPC")
        );
        assert_eq!(parse_loaded_backend("load_backend: loaded"), None);
        assert_eq!(parse_loaded_backend("some other line"), None);
    }
}
