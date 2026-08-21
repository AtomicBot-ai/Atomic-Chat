use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{Manager, Runtime};

/// Maps any persisted backend id (legacy janhq-style or already-clean
/// TurboQuant id) onto the **clean** TurboQuant id scheme used on
/// Windows/Linux/macOS:
///   `windows-x64-cpu`, `windows-x64-cuda-12.4`, `windows-x64-cuda-13.3`,
///   `windows-x64-vulkan`, `linux-x64-cpu`, `linux-x64-cuda-12.4`,
///   `linux-x64-cuda-13.3`, `linux-x64-rocm`, `linux-x64-vulkan`,
///   `macos-arm64`, `macos-x64`.
///
/// The manifest in `atomic-chat-conf` is the single source of "which tag";
/// here we only normalize the *backend id*. Idempotent: a clean id maps to
/// itself.
#[tauri::command]
pub fn map_old_backend_to_new(old_backend: String) -> String {
    let b = old_backend.replace('\u{FEFF}', "").trim().to_string();

    // Already-clean TurboQuant ids pass through unchanged (idempotent).
    match b.as_str() {
        "windows-x64-cpu"
        | "windows-x64-cuda-12.4"
        | "windows-x64-cuda-13.3"
        | "windows-x64-vulkan"
        | "linux-x64-cpu"
        | "linux-x64-cuda-12.4"
        | "linux-x64-cuda-13.3"
        | "linux-x64-rocm"
        | "linux-x64-vulkan"
        | "macos-arm64"
        | "macos-x64" => return b,
        _ => {}
    }

    // Legacy / clean Windows ids → clean Windows ids.
    if b.starts_with("win-") || b.starts_with("windows-") {
        if b.contains("cuda-13") || b.contains("cu13.0") {
            return "windows-x64-cuda-13.3".to_string();
        }
        if b.contains("cuda-12") || b.contains("cu12.0") {
            return "windows-x64-cuda-12.4".to_string();
        }
        // No TurboQuant Windows CUDA-11 build — fall back to CPU.
        if b.contains("cuda-11") || b.contains("cu11.7") {
            return "windows-x64-cpu".to_string();
        }
        if b.contains("vulkan") {
            return "windows-x64-vulkan".to_string();
        }
        // CPU / avx* variants.
        return "windows-x64-cpu".to_string();
    }

    // Legacy Linux ids (`linux-avx2-x64`, `ubuntu-vulkan-x64`, …) predate the
    // fork's Linux GPU tiers, so they all normalize onto `linux-x64-vulkan` —
    // the build that also carries a portable CPU path via GGML_BACKEND_DL. The
    // clean CUDA/ROCm/CPU ids returned above are never produced here; they only
    // ever come from the manifest or from hardware detection.
    if b.starts_with("linux-") {
        // No TurboQuant Linux arm64 build; leave unrecognized arm64 ids as-is.
        if b.contains("arm64") || b.contains("aarch64") {
            return b;
        }
        return "linux-x64-vulkan".to_string();
    }

    // macOS / unknown ids: unchanged.
    b
}

#[tauri::command]
pub async fn get_local_installed_backends(
    backends_dir: String,
) -> Result<Vec<BackendInfo>, String> {
    let mut local: Vec<BackendInfo> = Vec::new();
    let backends_path = PathBuf::from(&backends_dir);

    if !backends_path.exists() {
        return Ok(local);
    }

    let version_dirs = fs::read_dir(&backends_path)
        .map_err(|e| format!("Failed to read backends directory: {}", e))?;

    for version_entry in version_dirs {
        let version_entry =
            version_entry.map_err(|e| format!("Failed to read version entry: {}", e))?;

        let version_path = version_entry.path();

        let metadata =
            fs::metadata(&version_path).map_err(|e| format!("Failed to get metadata: {}", e))?;

        if !metadata.is_dir() {
            continue;
        }

        let version_name = match version_path.file_name() {
            Some(name) => name
                .to_string_lossy()
                .replace('\u{FEFF}', "")
                .trim()
                .to_string(),
            None => continue,
        };

        let backend_types = fs::read_dir(&version_path)
            .map_err(|e| format!("Failed to read version directory: {}", e))?;

        for backend_entry in backend_types {
            let backend_entry =
                backend_entry.map_err(|e| format!("Failed to read backend entry: {}", e))?;

            let backend_path = backend_entry.path();

            let backend_name = match backend_path.file_name() {
                Some(name) => name
                    .to_string_lossy()
                    .replace('\u{FEFF}', "")
                    .trim()
                    .to_string(),
                None => continue,
            };

            if is_backend_installed(&backend_path) {
                let order = fs::metadata(&backend_path)
                    .and_then(|m| m.modified())
                    .map(|t| {
                        t.duration_since(std::time::SystemTime::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs() as u32
                    })
                    .unwrap_or(0);

                local.push(BackendInfo {
                    version: version_name.clone(),
                    backend: backend_name,
                    order,
                });
            }
        }
    }

    Ok(local)
}

/// Helper function to check if a backend is properly installed
/// Checks for the existence of llama-server executable in the expected locations
fn is_backend_installed(backend_dir: &PathBuf) -> bool {
    if !backend_dir.exists() || !backend_dir.is_dir() {
        return false;
    }

    // Determine executable name based on platform
    let exe_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };

    // First check if build directory exists (build/bin/llama-server)
    let build_path = backend_dir.join("build").join("bin").join(exe_name);
    if build_path.exists() {
        return true;
    }

    // Otherwise check root directory (llama-server)
    let root_path = backend_dir.join(exe_name);
    root_path.exists()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BackendInfo {
    version: String,
    backend: String,
    #[serde(default)]
    order: u32,
}

#[derive(Deserialize)]
pub struct SystemFeatures {
    cuda11: bool,
    cuda12: bool,
    cuda13: bool,
    vulkan: bool,
    #[serde(default)]
    rocm: bool,
}

#[derive(Serialize)]
pub struct SupportedBackendsResult {
    supported_backend_names: Vec<String>,
    merged_backends: Vec<BackendInfo>,
}

#[tauri::command]
pub fn determine_supported_backends(
    os_type: String,
    arch: String,
    features: SystemFeatures,
) -> Result<Vec<String>, String> {
    let sys_type = format!("{}-{}", os_type, arch);
    let mut supported_backends: Vec<String> = Vec::new();

    // Determine supported backends based on system type and features, using
    // the clean TurboQuant id scheme. Windows and Linux both ship discrete
    // CPU/CUDA/Vulkan variants, Linux additionally an AMD ROCm one; macOS is
    // arm64-only (bundled).
    match sys_type.as_str() {
        "windows-x86_64" => {
            supported_backends.push("windows-x64-cpu".to_string());
            // No TurboQuant Windows CUDA-11 build (features.cuda11 ignored here).
            if features.cuda12 {
                supported_backends.push("windows-x64-cuda-12.4".to_string());
            }
            if features.cuda13 {
                supported_backends.push("windows-x64-cuda-13.3".to_string());
            }
            if features.vulkan {
                supported_backends.push("windows-x64-vulkan".to_string());
            }
        }
        "windows-aarch64" | "windows-arm64" => {
            // No TurboQuant Windows arm64 build.
            supported_backends.push("windows-arm64".to_string());
        }
        "linux-x86_64" | "linux-x86" => {
            supported_backends.push("linux-x64-cpu".to_string());
            // No TurboQuant Linux CUDA-11 build (features.cuda11 ignored here).
            if features.cuda12 {
                supported_backends.push("linux-x64-cuda-12.4".to_string());
            }
            if features.cuda13 {
                supported_backends.push("linux-x64-cuda-13.3".to_string());
            }
            // ROCm is offered only when the conservative host probe in
            // `get_supported_features` confirmed both a supported RDNA2–RDNA4
            // device and a usable ROCm runtime.
            if features.rocm {
                supported_backends.push("linux-x64-rocm".to_string());
            }
            // Always offered: the Vulkan build also carries a portable CPU path
            // (GGML_BACKEND_DL) and is the bundled offline fallback, so it must
            // stay installable even on a host with no Vulkan device.
            supported_backends.push("linux-x64-vulkan".to_string());
        }
        "linux-aarch64" | "linux-arm64" => {
            // No TurboQuant Linux arm64 build.
            supported_backends.push("linux-arm64".to_string());
        }
        "macos-x86_64" | "macos-x86" => {
            supported_backends.push("macos-x64".to_string());
        }
        "macos-aarch64" | "macos-arm64" => {
            supported_backends.push("macos-arm64".to_string());
        }
        _ => {
            return Err(format!("Unsupported system type: {}", sys_type));
        }
    }

    Ok(supported_backends)
}

fn is_windows_backend(backend: &str) -> bool {
    backend.starts_with("win-") || backend.starts_with("windows-")
}

/// Ordering key for a unified TurboQuant release tag
/// (`b<upstream-build>-<fork-major>.<minor>.<patch>`, e.g. `b10018-1.3.0`):
/// newest upstream build first, then newest fork version. Returns `None` for
/// legacy per-variant tags (`turboquant-<id>-<sha>`), which carry no monotonic
/// component at all.
fn unified_release_rank(version: &str) -> Option<(u32, u32, u32, u32)> {
    let (build, fork_semver) = version.strip_prefix('b')?.split_once('-')?;
    let build = build.parse::<u32>().ok()?;
    let mut parts = fork_semver.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((build, major, minor, patch))
}

fn compare_backend_versions_for_sort(
    left: &BackendInfo,
    right: &BackendInfo,
) -> std::cmp::Ordering {
    // Unified release tags are monotonic, so they decide directly, and any
    // unified release outranks every legacy tag — moving to the unified train
    // is always an upgrade.
    match (
        unified_release_rank(&left.version),
        unified_release_rank(&right.version),
    ) {
        (Some(left_rank), Some(right_rank)) => {
            let rank_cmp = right_rank.cmp(&left_rank);
            if rank_cmp != std::cmp::Ordering::Equal {
                return rank_cmp;
            }
        }
        (Some(_), None) => return std::cmp::Ordering::Less,
        (None, Some(_)) => return std::cmp::Ordering::Greater,
        (None, None) => {}
    }

    // Legacy TurboQuant release tags (`turboquant-<id>-<sha>`) are NOT
    // monotonic numbers, so numeric version comparison yields 0 for both and we
    // fall through to install `order`. The numeric short-circuit below is kept
    // for legacy janhq-style Windows ids (`win-*` with `bXXXX` numeric tags).
    if is_windows_backend(&left.backend) && is_windows_backend(&right.backend) {
        let left_version = parse_backend_version(left.version.clone());
        let right_version = parse_backend_version(right.version.clone());
        let version_cmp = right_version.cmp(&left_version);
        if version_cmp != std::cmp::Ordering::Equal {
            return version_cmp;
        }
    }

    let order_cmp = right.order.cmp(&left.order);
    if order_cmp != std::cmp::Ordering::Equal {
        return order_cmp;
    }

    let version_cmp = right.version.cmp(&left.version);
    if version_cmp != std::cmp::Ordering::Equal {
        return version_cmp;
    }

    left.backend.cmp(&right.backend)
}

#[tauri::command]
pub async fn list_supported_backends(
    remote_backend_versions: Vec<BackendInfo>,
    local_backend_versions: Vec<BackendInfo>,
) -> Result<Vec<BackendInfo>, String> {
    for entry in &remote_backend_versions {
        log::info!(
            "[list_supported_backends] remote: {}/{} order={}",
            entry.version,
            entry.backend,
            entry.order
        );
    }

    let mut merged_map: HashMap<String, BackendInfo> = HashMap::new();

    for entry in remote_backend_versions {
        let key = format!("{}|{}", entry.version, entry.backend);
        merged_map.insert(key, entry);
    }

    for entry in local_backend_versions {
        let key = format!("{}|{}", entry.version, entry.backend);
        merged_map
            .entry(key)
            .and_modify(|existing| {
                if entry.order > existing.order {
                    *existing = entry.clone();
                }
            })
            .or_insert(entry);
    }

    let mut merged: Vec<BackendInfo> = merged_map.into_values().collect();

    merged.sort_by(compare_backend_versions_for_sort);

    for entry in &merged {
        log::info!(
            "[list_supported_backends] sorted: {}/{} order={}",
            entry.version,
            entry.backend,
            entry.order
        );
    }

    Ok(merged)
}

#[derive(Serialize, Deserialize)]
pub struct SupportedFeatures {
    avx: bool,
    avx2: bool,
    avx512: bool,
    cuda11: bool,
    cuda12: bool,
    cuda13: bool,
    vulkan: bool,
    rocm: bool,
}

#[derive(Deserialize)]
pub struct GpuInfo {
    driver_version: String,
    #[serde(default)]
    vendor: Option<String>,
    nvidia_info: Option<NvidiaInfo>,
    vulkan_info: Option<VulkanInfo>,
}

#[derive(Deserialize)]
pub struct NvidiaInfo {
    /// NVML `"major.minor"` compute capability, e.g. `"7.0"` for Volta,
    /// `"7.5"` for Turing. `#[serde(default)]` because a payload whose
    /// `nvidia_info` object lacks the field must not fail deserialization of
    /// the whole `gpus` argument: the TS caller swallows the invoke error and
    /// returns an *empty* supported-backend list, which would hide every
    /// backend rather than just the CUDA-13 one.
    #[serde(default)]
    compute_capability: String,
}

#[derive(Deserialize)]
pub struct VulkanInfo {
    api_version: String,
}

/// Lowest NVIDIA compute capability a CUDA-13 build still carries kernels for.
///
/// CUDA Toolkit 13.0 removed Maxwell (5.x), Pascal (6.x) and Volta (7.0)
/// entirely, so Turing (7.5) is the floor for every `cuda-13.x` archive we
/// offer — on Linux as well as Windows, since this provider is the one that
/// ships `linux-x64-cuda-13.3`. A Volta-or-older card handed a CUDA-13 build
/// dies at `ggml_cuda_init` with "no kernel image is available for execution
/// on the device".
///
/// The driver gate below cannot catch this on its own: R580 is the *last*
/// branch that still supports Maxwell/Pascal/Volta, so those cards
/// legitimately report a driver at or above the CUDA-13 floor and sailed
/// straight through. Reported by a user on a dual-Volta host that the app
/// kept recommending CUDA 13 to.
///
/// Kept in sync by hand with the twin in
/// `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs` — the two
/// plugins are independent crates with deliberately divergent driver floors.
const MIN_CUDA13_COMPUTE_CAPABILITY: (u32, u32) = (7, 5);

/// Parse an NVML `"major.minor"` compute capability.
///
/// Returns `None` for anything unreadable, which callers treat as "unknown —
/// do not gate". That direction is deliberate: our hardware plugin drops a GPU
/// entirely when NVML cannot report its capability, so `None` is unreachable
/// in practice, and guessing "too old" would push a Blackwell host (CC 10.0 /
/// 12.0) down onto the CUDA 12.4 archive, which has no kernels for it either.
fn parse_compute_capability(raw: &str) -> Option<(u32, u32)> {
    let mut parts = raw.trim().split('.');
    let major: u32 = parts.next()?.trim().parse().ok()?;
    let minor: u32 = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
    Some((major, minor))
}

/// Whether this GPU's architecture is new enough for a CUDA-13 build.
/// Tuple comparison is lexicographic, so `(10, 0) >= (7, 5)` holds — a plain
/// string or float compare would get Blackwell wrong.
fn gpu_meets_cuda13_arch_floor(nvidia: &NvidiaInfo) -> bool {
    match parse_compute_capability(&nvidia.compute_capability) {
        Some(cc) => cc >= MIN_CUDA13_COMPUTE_CAPABILITY,
        // Unknown capability — leave the driver gate in charge, as before.
        None => true,
    }
}

/// GPU architectures the fork's `linux-x64-rocm` archive is compiled for —
/// RDNA2 through RDNA4, i.e. gfx1030/1100/1101/1102/1151/1200/1201 — expressed
/// as amdkfd `gfx_target_version` values (major * 10000 + minor * 100 + step).
/// Older GCN cards are not in the build and must use Vulkan.
const ROCM_SUPPORTED_GFX_TARGET_VERSIONS: &[u32] =
    &[100300, 110000, 110100, 110200, 115100, 120000, 120100];

fn is_amd_gpu(gpu: &GpuInfo) -> bool {
    gpu.vendor
        .as_deref()
        .is_some_and(|v| v.eq_ignore_ascii_case("amd"))
}

/// The ROCm decision, kept free of I/O so the policy itself is testable.
///
/// Deliberately conservative: every input must be affirmative. An AMD card we
/// cannot place in the supported architecture set, or a host without a ROCm
/// runtime, yields `false` and the caller falls back to Vulkan — a slower but
/// working GPU path beats an archive that aborts on load.
fn rocm_supported(has_amd_gpu: bool, gfx_target_versions: &[u32], has_runtime: bool) -> bool {
    has_amd_gpu
        && has_runtime
        && gfx_target_versions
            .iter()
            .any(|v| ROCM_SUPPORTED_GFX_TARGET_VERSIONS.contains(v))
}

/// Read the GPU architectures the amdgpu kernel driver exposes to ROCm, from
/// `/sys/class/kfd/kfd/topology/nodes/*/properties`. Nodes that are not GPUs
/// report `gfx_target_version 0` and are skipped. Reading sysfs keeps the probe
/// free of a HIP link-time or runtime dependency.
#[cfg(target_os = "linux")]
fn amdkfd_gfx_target_versions() -> Vec<u32> {
    let Ok(nodes) = fs::read_dir("/sys/class/kfd/kfd/topology/nodes") else {
        return Vec::new();
    };
    let mut versions = Vec::new();
    for node in nodes.flatten() {
        let Ok(properties) = fs::read_to_string(node.path().join("properties")) else {
            continue;
        };
        for line in properties.lines() {
            let Some(value) = line.strip_prefix("gfx_target_version ") else {
                continue;
            };
            if let Ok(version) = value.trim().parse::<u32>() {
                if version != 0 {
                    versions.push(version);
                }
            }
        }
    }
    versions
}

#[cfg(not(target_os = "linux"))]
fn amdkfd_gfx_target_versions() -> Vec<u32> {
    Vec::new()
}

/// Whether a ROCm/HIP runtime is installed on the host. The archive links
/// against `libamdhip64.so`, so its presence in a ROCm install prefix or on the
/// default library path is the cheapest honest signal that the build can start.
#[cfg(target_os = "linux")]
fn host_has_rocm_runtime() -> bool {
    const LIBRARY_DIRS: &[&str] = &[
        "/opt/rocm/lib",
        "/opt/rocm/lib64",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib64",
        "/usr/lib",
    ];
    if LIBRARY_DIRS
        .iter()
        .any(|dir| PathBuf::from(dir).join("libamdhip64.so").exists())
    {
        return true;
    }
    // Versioned side-by-side installs, e.g. /opt/rocm-6.2.0/lib.
    let Ok(entries) = fs::read_dir("/opt") else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .starts_with("rocm-")
            && (entry.path().join("lib/libamdhip64.so").exists()
                || entry.path().join("lib64/libamdhip64.so").exists())
    })
}

#[cfg(not(target_os = "linux"))]
fn host_has_rocm_runtime() -> bool {
    false
}

#[tauri::command]
pub fn get_supported_features(
    os_type: String,
    cpu_extensions: Vec<String>,
    gpus: Vec<GpuInfo>,
) -> Result<SupportedFeatures, String> {
    let mut features = SupportedFeatures {
        avx: cpu_extensions.contains(&"avx".to_string()),
        avx2: cpu_extensions.contains(&"avx2".to_string()),
        avx512: cpu_extensions.contains(&"avx512".to_string()),
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: false,
        rocm: false,
    };

    // The fork's ROCm archive is Linux-only.
    if os_type == "linux" {
        features.rocm = rocm_supported(
            gpus.iter().any(is_amd_gpu),
            &amdkfd_gfx_target_versions(),
            host_has_rocm_runtime(),
        );
    }

    // https://docs.nvidia.com/deploy/cuda-compatibility/#cuda-11-and-later-defaults-to-minor-version-compatibility
    // Windows CUDA 13 floor is the NVIDIA-documented CUDA Toolkit 13.1 minimum
    // driver (581.15), matching the llamacpp-upstream plugin.
    let (min_cuda11_driver, min_cuda12_driver, min_cuda13_driver) = match os_type.as_str() {
        "linux" => ("450.80.02", "525.60.13", "580"),
        "windows" => ("452.39", "527.41", "581.15"),
        _ => return Ok(features), // Other OS types don't support CUDA
    };

    // Check GPU features
    //
    // The driver is a single system-wide version, so *any* NVIDIA GPU passing
    // a driver floor enables that tier. Architecture is per-card and must hold
    // for *every* card: llama.cpp's CUDA build enumerates and offloads across
    // all visible devices, so one too-old GPU fails the whole run.
    let mut all_nvidia_meet_cuda13_arch = true;
    for gpu_info in gpus {
        let driver_version = &gpu_info.driver_version;

        // Check CUDA support
        if let Some(nvidia_info) = gpu_info.nvidia_info.as_ref() {
            if compare_versions(driver_version, min_cuda11_driver) >= 0 {
                features.cuda11 = true;
            }
            if compare_versions(driver_version, min_cuda12_driver) >= 0 {
                features.cuda12 = true;
            }
            if compare_versions(driver_version, min_cuda13_driver) >= 0 {
                features.cuda13 = true;
            }
            if !gpu_meets_cuda13_arch_floor(nvidia_info) {
                log::info!(
                    "[get_supported_features] CUDA 13 disabled: GPU compute capability {} is below {}.{} (Turing)",
                    nvidia_info.compute_capability,
                    MIN_CUDA13_COMPUTE_CAPABILITY.0,
                    MIN_CUDA13_COMPUTE_CAPABILITY.1
                );
                all_nvidia_meet_cuda13_arch = false;
            }
        }

        // Check Vulkan support
        if gpu_info.vulkan_info.is_some() {
            features.vulkan = true;
        }
    }

    // Architecture veto, applied after every GPU has been seen. CUDA 12.4 has
    // kernels for Maxwell through Hopper, so the vetoed host still lands on a
    // working CUDA tier rather than dropping to Vulkan.
    features.cuda13 &= all_nvidia_meet_cuda13_arch;

    Ok(features)
}

/// Compare version strings
/// Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
fn compare_versions(v1: &str, v2: &str) -> i32 {
    let parts1: Vec<&str> = v1.split('.').collect();
    let parts2: Vec<&str> = v2.split('.').collect();

    let max_len = parts1.len().max(parts2.len());

    for i in 0..max_len {
        let num1 = parts1
            .get(i)
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        let num2 = parts2
            .get(i)
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);

        match num1.cmp(&num2) {
            std::cmp::Ordering::Less => return -1,
            std::cmp::Ordering::Greater => return 1,
            std::cmp::Ordering::Equal => continue,
        }
    }

    0
}

/// Copy Windows CUDA runtime DLLs (`cudart*`, `cublas*`, …) from one
/// `build/bin` directory into another without removing the source.
///
/// Used by the TurboQuant provider to repair CUDA backends that shipped
/// without their runtime DLLs by copying from an already-installed
/// `llamacpp-upstream` CUDA bin (or any other donor directory). Prefixes
/// are matched case-insensitively against the file stem+extension.
#[tauri::command]
pub async fn copy_backend_dlls(
    src_dir: String,
    dst_dir: String,
    name_prefixes: Vec<String>,
) -> Result<u32, String> {
    use std::path::PathBuf;

    let src = PathBuf::from(&src_dir);
    let dst = PathBuf::from(&dst_dir);
    if !src.is_dir() {
        return Err(format!("source dir does not exist: {src_dir}"));
    }
    std::fs::create_dir_all(&dst).map_err(|e| format!("create {dst_dir}: {e}"))?;

    let prefixes_lower: Vec<String> = name_prefixes
        .iter()
        .map(|p| p.to_ascii_lowercase())
        .collect();

    let mut copied = 0u32;
    for entry in std::fs::read_dir(&src).map_err(|e| format!("read {src_dir}: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".dll") {
            continue;
        }
        if !prefixes_lower.iter().any(|p| lower.starts_with(p.as_str())) {
            continue;
        }
        let dest = dst.join(name);
        std::fs::copy(&path, &dest).map_err(|e| format!("copy {name}: {e}"))?;
        copied += 1;
    }
    Ok(copied)
}

#[tauri::command]
pub async fn is_cuda_installed(
    backend_dir: String,
    version: String,
    os_type: String,
    jan_data_folder_path: String,
) -> Result<bool, String> {
    // Probe for the CUDA runtime lib in the backend's own `build/bin`.
    // TurboQuant release zips *should* ship cudart/cublas inline; when they
    // do not, the extension repairs via copy-from-upstream or a ggml-org
    // companion download. `jan_data_folder_path` is unused but kept for IPC
    // compatibility with the upstream plugin signature.
    let _ = jan_data_folder_path;

    // Resolve the cudart runtime lib name by CUDA major version. The `version`
    // is the toolkit minor (e.g. "12.4" / "13.3") for clean TurboQuant ids, or
    // the legacy "11.7" / "12.0" / "13.0" for older janhq-style ids.
    let major = version.split('.').next().unwrap_or("");
    let libname: &str = match (os_type.as_str(), major) {
        ("windows", "11") => "cudart64_110.dll",
        ("windows", "12") => "cudart64_12.dll",
        ("windows", "13") => "cudart64_13.dll",
        ("linux", "11") => "libcudart.so.11.0",
        ("linux", "12") => "libcudart.so.12",
        ("linux", "13") => "libcudart.so.13",
        _ => return Ok(false),
    };

    // Expected location: backend_dir/build/bin/libname
    let new_path = std::path::PathBuf::from(&backend_dir)
        .join("build")
        .join("bin")
        .join(libname);

    Ok(new_path.exists())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BestBackendResult {
    pub backend_string: String,
    pub version: String,
    pub backend_type: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateCheckResult {
    pub update_needed: bool,
    pub new_version: String,
    pub target_backend: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BackendConfigResult {
    pub best_available: String,
    pub effective_backend: String,
    pub backend_downloaded: bool,
    pub settings_updated: bool,
}

#[tauri::command]
pub fn find_latest_version_for_backend(
    version_backends: Vec<BackendInfo>,
    backend_type: String,
) -> Option<String> {
    let mut matching_backends: Vec<BackendInfo> = version_backends
        .into_iter()
        .filter(|vb| map_old_backend_to_new(vb.backend.clone()) == backend_type)
        .collect();

    if matching_backends.is_empty() {
        return None;
    }

    matching_backends.sort_by(compare_backend_versions_for_sort);

    Some(format!(
        "{}/{}",
        matching_backends[0].version, matching_backends[0].backend
    ))
}

#[tauri::command]
pub async fn prioritize_backends(
    version_backends: Vec<BackendInfo>,
    has_enough_gpu_memory: bool,
) -> Result<BestBackendResult, String> {
    if version_backends.is_empty() {
        return Err("No backends available".to_string());
    }

    // Priority list based on GPU memory
    let backend_priorities: Vec<&str> = if has_enough_gpu_memory {
        vec![
            "cuda-cu13.0",
            "cuda-cu12.0",
            "cuda-cu11.7",
            "rocm",
            "vulkan",
            "common_cpus",
            "avx512",
            "avx2",
            "avx",
            "noavx",
            "arm64",
            "x64",
        ]
    } else {
        vec![
            "cuda-cu13.0",
            "cuda-cu12.0",
            "cuda-cu11.7",
            "common_cpus",
            "avx512",
            "avx2",
            "avx",
            "noavx",
            "arm64",
            "x64",
            "rocm",
            "vulkan",
        ]
    };

    // Find best matching backend
    for priority_category in backend_priorities {
        let matching_backends: Vec<&BackendInfo> = version_backends
            .iter()
            .filter(|vb| {
                let category = get_backend_category(&vb.backend);
                category.as_deref() == Some(priority_category)
            })
            .collect();

        if !matching_backends.is_empty() {
            let best = matching_backends
                .into_iter()
                .max_by(|left, right| compare_backend_versions_for_sort(right, left))
                .unwrap();
            log::info!(
                "Determined best available backend: {}/{} (Category: \"{}\")",
                best.version,
                best.backend,
                priority_category
            );

            return Ok(BestBackendResult {
                backend_string: format!("{}/{}", best.version, best.backend),
                version: best.version.clone(),
                backend_type: best.backend.clone(),
            });
        }
    }

    // Fallback to newest version
    let fallback = &version_backends[0];
    log::info!("Fallback to: {}/{}", fallback.version, fallback.backend);

    Ok(BestBackendResult {
        backend_string: format!("{}/{}", fallback.version, fallback.backend),
        version: fallback.version.clone(),
        backend_type: fallback.backend.clone(),
    })
}

fn get_backend_category(backend_string: &str) -> Option<String> {
    // Matches both legacy ids (`*-cuda-13-common_cpus-*`) and clean TurboQuant
    // ids (`windows-x64-cuda-13.3`).
    if backend_string.contains("cuda-13") || backend_string.contains("cu13.0") {
        return Some("cuda-cu13.0".to_string());
    }
    if backend_string.contains("cuda-12") || backend_string.contains("cu12.0") {
        return Some("cuda-cu12.0".to_string());
    }
    if backend_string.contains("cuda-11") || backend_string.contains("cu11.7") {
        return Some("cuda-cu11.7".to_string());
    }
    if backend_string.contains("rocm") {
        return Some("rocm".to_string());
    }
    if backend_string.contains("vulkan") {
        return Some("vulkan".to_string());
    }
    // Legacy `*-common_cpus-*` and clean `windows-x64-cpu`.
    if backend_string.contains("common_cpus") || backend_string.contains("-cpu") {
        return Some("common_cpus".to_string());
    }
    if backend_string.contains("avx512") {
        return Some("avx512".to_string());
    }
    if backend_string.contains("avx2") {
        return Some("avx2".to_string());
    }
    if backend_string.contains("avx")
        && !backend_string.contains("avx2")
        && !backend_string.contains("avx512")
    {
        return Some("avx".to_string());
    }
    if backend_string.contains("noavx") {
        return Some("noavx".to_string());
    }
    if backend_string.ends_with("arm64") {
        return Some("arm64".to_string());
    }
    if backend_string.ends_with("x64") {
        return Some("x64".to_string());
    }
    None
}

#[tauri::command]
pub fn parse_backend_version(version_string: String) -> u32 {
    // Remove any leading non-digit characters
    let numeric = version_string.trim_start_matches(|c: char| !c.is_ascii_digit());
    numeric.parse::<u32>().unwrap_or(0)
}

#[tauri::command]
pub async fn check_backend_for_updates(
    current_backend_string: String,
    version_backends: Vec<BackendInfo>,
) -> Result<UpdateCheckResult, String> {
    let parts: Vec<&str> = current_backend_string.split('/').collect();
    if parts.len() != 2 {
        return Err(format!(
            "Invalid current backend format: {}",
            current_backend_string
        ));
    }

    let current_backend = parts[1];

    // Get the effective/migrated backend type
    let current_effective_backend_type = map_old_backend_to_new(current_backend.to_string());

    // Find the latest version for the current backend type
    let target_backend_string =
        find_latest_version_for_backend(version_backends, current_effective_backend_type.clone());

    if target_backend_string.is_none() {
        log::warn!(
            "No available versions found for current backend type: {}",
            current_effective_backend_type
        );
        return Ok(UpdateCheckResult {
            update_needed: false,
            new_version: "0".to_string(),
            target_backend: None,
        });
    }

    let target_backend_string = target_backend_string.unwrap();
    let target_parts: Vec<&str> = target_backend_string.split('/').collect();
    let latest_version = target_parts[0];

    // Update is needed when the order-based latest target differs from current
    if target_backend_string != current_backend_string {
        log::info!(
            "New update available: {} -> {}",
            current_backend_string,
            target_backend_string
        );
        Ok(UpdateCheckResult {
            update_needed: true,
            new_version: latest_version.to_string(),
            target_backend: Some(target_backend_string),
        })
    } else {
        log::info!("Already at latest version: {}", current_backend_string);
        Ok(UpdateCheckResult {
            update_needed: false,
            new_version: "0".to_string(),
            target_backend: None,
        })
    }
}

#[tauri::command]
pub async fn remove_old_backend_versions(
    backends_dir: String,
    latest_version: String,
    backend_type: String,
) -> Result<Vec<String>, String> {
    let mut removed_paths = Vec::new();
    let backends_path = PathBuf::from(&backends_dir);

    if !backends_path.exists() {
        return Ok(removed_paths);
    }

    let version_dirs = fs::read_dir(&backends_path)
        .map_err(|e| format!("Failed to read backends directory: {}", e))?;

    for version_entry in version_dirs {
        let version_entry =
            version_entry.map_err(|e| format!("Failed to read version entry: {}", e))?;

        let version_path = version_entry.path();
        let version_name = match version_path.file_name() {
            Some(name) => name.to_string_lossy().to_string(),
            None => continue,
        };

        // Skip the latest version
        if version_name == latest_version {
            continue;
        }

        // Check if this version has the specific backend type
        let backend_type_path = version_path.join(&backend_type);

        if backend_type_path.exists() {
            // Verify it's actually installed before removing
            if is_backend_installed(&backend_type_path) {
                match fs::remove_dir_all(&backend_type_path) {
                    Ok(_) => {
                        log::info!(
                            "Removed old version of {}: {}",
                            backend_type,
                            backend_type_path.display()
                        );
                        removed_paths.push(backend_type_path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to remove old backend version: {} - {}",
                            backend_type_path.display(),
                            e
                        );
                    }
                }
            }
        }
    }

    Ok(removed_paths)
}

#[tauri::command]
pub fn validate_backend_string(backend_string: String) -> Result<(String, String), String> {
    let parts: Vec<&str> = backend_string.split('/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid backend format: {}", backend_string));
    }

    let version = parts[0].trim();
    let backend = parts[1].trim();

    if version.is_empty() || backend.is_empty() {
        return Err(format!("Invalid backend format: {}", backend_string));
    }

    Ok((version.to_string(), backend.to_string()))
}

#[tauri::command]
pub fn should_migrate_backend(
    stored_backend_type: String,
    version_backends: Vec<BackendInfo>,
) -> Result<Option<String>, String> {
    let mapped_new_backend_type = map_old_backend_to_new(stored_backend_type.clone());
    let is_migration_needed = mapped_new_backend_type != stored_backend_type;

    if !is_migration_needed {
        return Ok(None);
    }

    // Check if the new, mapped backend is available
    let is_new_type_available = version_backends
        .iter()
        .any(|vb| map_old_backend_to_new(vb.backend.clone()) == mapped_new_backend_type);

    if is_new_type_available {
        log::info!(
            "Migration needed from '{}' to '{}'",
            stored_backend_type,
            mapped_new_backend_type
        );
        Ok(Some(mapped_new_backend_type))
    } else {
        log::warn!(
            "Migration from '{}' to '{}' skipped: New type not available",
            stored_backend_type,
            mapped_new_backend_type
        );
        Ok(None)
    }
}

// ============================================================================
// Settings Update Handler
// ============================================================================

#[derive(Serialize, Deserialize, Debug)]
pub struct SettingUpdateResult {
    pub backend_type_updated: bool,
    pub effective_backend_type: Option<String>,
    pub needs_backend_installation: bool,
    pub version: Option<String>,
    pub backend: Option<String>,
}

#[tauri::command]
pub fn handle_setting_update(
    key: String,
    value: String,
    current_stored_backend: Option<String>,
) -> Result<SettingUpdateResult, String> {
    if key != "version_backend" {
        // For non-backend settings, return a simple result
        return Ok(SettingUpdateResult {
            backend_type_updated: false,
            effective_backend_type: None,
            needs_backend_installation: false,
            version: None,
            backend: None,
        });
    }

    // Handle version_backend update — strip BOM that may persist in saved settings
    let clean_value = value.replace('\u{FEFF}', "");
    let parts: Vec<&str> = clean_value.split('/').collect();
    if parts.len() != 2 {
        return Err(format!("Invalid backend format: {}", clean_value));
    }

    let version = parts[0].trim().to_string();
    let backend = parts[1].trim().to_string();

    if version.is_empty() || backend.is_empty() {
        return Err(format!("Invalid backend format: {}", value));
    }

    // Get the effective/migrated backend type
    let effective_backend_type = map_old_backend_to_new(backend.clone());

    // Check if backend type changed
    let backend_type_updated = match current_stored_backend {
        Some(stored) => stored != effective_backend_type,
        None => true,
    };

    log::info!(
        "Setting update for version_backend: {}/{} (effective: {})",
        version,
        backend,
        effective_backend_type
    );

    Ok(SettingUpdateResult {
        backend_type_updated,
        effective_backend_type: Some(effective_backend_type),
        needs_backend_installation: true,
        version: Some(version),
        backend: Some(backend),
    })
}

// ============================================================================
// Bundled Backend Installation
// ============================================================================

#[derive(Serialize, Deserialize, Debug)]
pub struct BundledBackendResult {
    pub installed: bool,
    pub backend_string: Option<String>,
    pub version: Option<String>,
    pub backend: Option<String>,
}

fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {}", dst.display(), e))?;

    for entry in fs::read_dir(src).map_err(|e| format!("readdir {}: {}", src.display(), e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "copy {} → {}: {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

/// Returns true only when every file present under the resource `build/` tree
/// also exists under the installed `build/` tree. Guards against a partially
/// installed bundled backend - e.g. a pre-fix victim that has
/// `build/bin/llama-server.exe` (so `is_backend_installed` reports true) but is
/// missing sibling DLLs such as `llama-server-impl.dll` that a flat-extract CI
/// step stranded. Missing destination dir/file => incomplete (false).
fn bundled_backend_is_complete(resource_build: &PathBuf, target_build: &PathBuf) -> bool {
    let entries = match fs::read_dir(resource_build) {
        Ok(e) => e,
        Err(_) => return false,
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => return false,
        };
        let src_path = entry.path();
        let dst_path = target_build.join(entry.file_name());

        if src_path.is_dir() {
            if !bundled_backend_is_complete(&src_path, &dst_path) {
                return false;
            }
        } else if !dst_path.exists() {
            return false;
        }
    }
    true
}

#[tauri::command]
pub async fn install_bundled_backend<R: Runtime>(
    app: tauri::AppHandle<R>,
    backends_dir: String,
) -> Result<BundledBackendResult, String> {
    let not_bundled = Ok(BundledBackendResult {
        installed: false,
        backend_string: None,
        version: None,
        backend: None,
    });

    let mut resource_dir: Option<PathBuf> = None;

    // Try Tauri resource resolution (works in production builds)
    for candidate in &["resources/llamacpp-backend", "llamacpp-backend"] {
        if let Ok(p) = app
            .path()
            .resolve(candidate, tauri::path::BaseDirectory::Resource)
        {
            log::info!(
                "[install_bundled_backend] Trying resource path '{}' → {}",
                candidate,
                p.display()
            );
            if p.join("version.txt").exists() {
                resource_dir = Some(p);
                break;
            }
        }
    }

    // Dev mode fallback: resources live in src-tauri/resources/ relative to plugin crate
    if resource_dir.is_none() {
        let dev_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/llamacpp-backend");
        log::info!(
            "[install_bundled_backend] Trying dev fallback → {}",
            dev_path.display()
        );
        if dev_path.join("version.txt").exists() {
            resource_dir = Some(dev_path);
        }
    }

    let resource_dir = match resource_dir {
        Some(p) => p,
        None => {
            log::info!("[install_bundled_backend] No bundled backend found in any candidate path");
            return not_bundled;
        }
    };

    let version_file = resource_dir.join("version.txt");
    let backend_file = resource_dir.join("backend.txt");
    let build_dir = resource_dir.join("build");

    if !version_file.exists() || !backend_file.exists() || !build_dir.exists() {
        log::info!(
            "[install_bundled_backend] Missing files at {}",
            resource_dir.display()
        );
        return not_bundled;
    }

    let version = fs::read_to_string(&version_file)
        .map_err(|e| format!("read version.txt: {}", e))?
        .replace('\u{FEFF}', "")
        .trim()
        .to_string();
    let backend = fs::read_to_string(&backend_file)
        .map_err(|e| format!("read backend.txt: {}", e))?
        .replace('\u{FEFF}', "")
        .trim()
        .to_string();

    if version.is_empty() || backend.is_empty() {
        log::warn!("[install_bundled_backend] Empty version or backend in meta files");
        return not_bundled;
    }

    let target_dir = PathBuf::from(&backends_dir).join(&version).join(&backend);
    let target_build_dir = target_dir.join("build");

    if is_backend_installed(&target_dir) {
        // The exe is present, but a pre-fix flat-extract CI step may have
        // stranded sibling DLLs (e.g. llama-server-impl.dll) at the resource
        // root, leaving this install incomplete. Re-copy the resource build/
        // tree to backfill the missing files instead of silently skipping.
        if bundled_backend_is_complete(&build_dir, &target_build_dir) {
            log::info!(
                "[install_bundled_backend] Bundled backend already installed: {}/{}",
                version,
                backend
            );
        } else {
            log::warn!(
                "[install_bundled_backend] Bundled backend {}/{} present but incomplete; backfilling missing files",
                version, backend
            );
            copy_dir_recursive(&build_dir, &target_build_dir)?;
        }
        return Ok(BundledBackendResult {
            installed: true,
            backend_string: Some(format!("{}/{}", version, backend)),
            version: Some(version),
            backend: Some(backend),
        });
    }

    log::info!(
        "[install_bundled_backend] Installing bundled backend {}/{} from {}",
        version,
        backend,
        resource_dir.display()
    );

    copy_dir_recursive(&build_dir, &target_build_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin_dir = target_build_dir.join("bin");
        if bin_dir.exists() {
            for entry in fs::read_dir(&bin_dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    let mut perms = fs::metadata(entry.path())
                        .map_err(|e| e.to_string())?
                        .permissions();
                    perms.set_mode(0o755);
                    fs::set_permissions(entry.path(), perms).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    log::info!(
        "[install_bundled_backend] Successfully installed bundled backend: {}/{}",
        version,
        backend
    );

    Ok(BundledBackendResult {
        installed: true,
        backend_string: Some(format!("{}/{}", version, backend)),
        version: Some(version),
        backend: Some(backend),
    })
}

// ---------------------------- Tests ------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use filetime;
    use std::fs::File;
    use std::io::Write;

    // --- Tests for map_old_backend_to_new ---

    #[test]
    fn test_map_old_backend_to_new_cuda() {
        // Legacy Linux CUDA → single linux-x64-vulkan build (no TurboQuant CUDA-on-Linux).
        assert_eq!(
            map_old_backend_to_new("linux-avx2-cuda-cu12.0-x64".to_string()),
            "linux-x64-vulkan"
        );
        // Legacy Windows CUDA 11 → CPU (no TurboQuant Windows CUDA-11 build).
        assert_eq!(
            map_old_backend_to_new("win-noavx-cuda-cu11.7-x64".to_string()),
            "windows-x64-cpu"
        );
        // Legacy Windows CUDA 12 → clean windows-x64-cuda-12.4.
        assert_eq!(
            map_old_backend_to_new("win-cuda-12-common_cpus-x64".to_string()),
            "windows-x64-cuda-12.4"
        );
        // Legacy Windows CUDA 13 → clean windows-x64-cuda-13.3.
        assert_eq!(
            map_old_backend_to_new("win-cuda-13-common_cpus-x64".to_string()),
            "windows-x64-cuda-13.3"
        );
        // Clean ids are idempotent.
        assert_eq!(
            map_old_backend_to_new("windows-x64-cuda-12.4".to_string()),
            "windows-x64-cuda-12.4"
        );
        assert_eq!(
            map_old_backend_to_new("windows-x64-cuda-13.3".to_string()),
            "windows-x64-cuda-13.3"
        );
    }

    #[test]
    fn test_map_old_backend_to_new_vulkan() {
        // Legacy Linux Vulkan → clean linux-x64-vulkan.
        assert_eq!(
            map_old_backend_to_new("linux-vulkan-x64".to_string()),
            "linux-x64-vulkan"
        );
        // Legacy Windows Vulkan → clean windows-x64-vulkan.
        assert_eq!(
            map_old_backend_to_new("win-vulkan-common_cpus-x64".to_string()),
            "windows-x64-vulkan"
        );
        // Clean ids are idempotent.
        assert_eq!(
            map_old_backend_to_new("linux-x64-vulkan".to_string()),
            "linux-x64-vulkan"
        );
        assert_eq!(
            map_old_backend_to_new("windows-x64-vulkan".to_string()),
            "windows-x64-vulkan"
        );
    }

    #[test]
    fn test_map_old_backend_to_new_cpu() {
        // Legacy Windows AVX512 → clean windows-x64-cpu.
        assert_eq!(
            map_old_backend_to_new("win-avx512-x64".to_string()),
            "windows-x64-cpu"
        );
        // Legacy Windows common_cpus → clean windows-x64-cpu.
        assert_eq!(
            map_old_backend_to_new("win-common_cpus-x64".to_string()),
            "windows-x64-cpu"
        );
        // Legacy Linux AVX2 → single linux-x64-vulkan build.
        assert_eq!(
            map_old_backend_to_new("linux-avx2-x64".to_string()),
            "linux-x64-vulkan"
        );
        // Clean windows-x64-cpu is idempotent.
        assert_eq!(
            map_old_backend_to_new("windows-x64-cpu".to_string()),
            "windows-x64-cpu"
        );
    }

    #[test]
    fn test_map_old_backend_to_new_arch() {
        // ARM64 ids have no TurboQuant build and are returned unchanged.
        assert_eq!(
            map_old_backend_to_new("linux-arm64".to_string()),
            "linux-arm64"
        );
        // macOS ids pass through.
        assert_eq!(
            map_old_backend_to_new("macos-arm64".to_string()),
            "macos-arm64"
        );
    }

    // --- Tests for compare_versions (Private helper) ---

    #[test]
    fn test_compare_versions() {
        assert_eq!(compare_versions("1.0", "2.0"), -1);
        assert_eq!(compare_versions("2.0", "1.0"), 1);
        assert_eq!(compare_versions("1.0", "1.0"), 0);
        assert_eq!(compare_versions("1.0.1", "1.0"), 1);
        assert_eq!(compare_versions("450.80.02", "450.80.02"), 0);
        assert_eq!(compare_versions("525.60.13", "450.80.02"), 1);
        assert_eq!(compare_versions("10", "2"), 1); // Numeric check, not string
    }

    // --- Tests for get_supported_features ---

    #[test]
    fn test_get_supported_features_cpu_only() {
        let gpus = vec![];
        let exts = vec!["avx".to_string(), "avx2".to_string()];

        let result = get_supported_features("linux".to_string(), exts, gpus).unwrap();

        assert!(result.avx);
        assert!(result.avx2);
        assert!(!result.avx512);
        assert!(!result.cuda11);
        assert!(!result.vulkan);
    }

    #[test]
    fn test_get_supported_features_cuda_linux() {
        // Driver 525.60.13 supports CUDA 12 on Linux
        let gpus = vec![GpuInfo {
            driver_version: "530.00".to_string(),
            vendor: Some("NVIDIA".to_string()),
            nvidia_info: Some(NvidiaInfo {
                compute_capability: "8.0".to_string(),
            }),
            vulkan_info: None,
        }];

        let result = get_supported_features("linux".to_string(), vec![], gpus).unwrap();

        assert!(result.cuda11); // 530 > 450
        assert!(result.cuda12); // 530 > 525
        assert!(!result.cuda13); // 530 < 580
    }

    #[test]
    fn test_get_supported_features_vulkan() {
        let gpus = vec![GpuInfo {
            driver_version: "0.0".to_string(),
            vendor: Some("AMD".to_string()),
            nvidia_info: None,
            vulkan_info: Some(VulkanInfo {
                api_version: "1.3".to_string(),
            }),
        }];

        let result = get_supported_features("windows".to_string(), vec![], gpus).unwrap();

        assert!(result.vulkan);
        assert!(!result.cuda11);
    }

    // --- Compute-capability gate for CUDA 13 ---
    //
    // Mirrors the suite in
    // `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`.
    // Exercised on Linux here because this is the provider that ships
    // `linux-x64-cuda-13.3`.

    fn nvidia_gpu_cc(driver_version: &str, compute_capability: &str) -> GpuInfo {
        GpuInfo {
            driver_version: driver_version.to_string(),
            vendor: Some("NVIDIA".to_string()),
            nvidia_info: Some(NvidiaInfo {
                compute_capability: compute_capability.to_string(),
            }),
            vulkan_info: None,
        }
    }

    #[test]
    fn test_parse_compute_capability() {
        assert_eq!(parse_compute_capability("7.0"), Some((7, 0)));
        assert_eq!(parse_compute_capability("7.5"), Some((7, 5)));
        assert_eq!(parse_compute_capability(" 12.0 "), Some((12, 0)));
        // Major only — NVML always emits "major.minor", but be lenient.
        assert_eq!(parse_compute_capability("8"), Some((8, 0)));
        // Unreadable input is reported as unknown, never as "old".
        assert_eq!(parse_compute_capability(""), None);
        assert_eq!(parse_compute_capability("unknown"), None);
    }

    #[test]
    fn test_volta_does_not_get_cuda13_despite_new_driver() {
        // The reported bug: R580 still supports Volta, so a Volta card
        // legitimately reports a driver above the CUDA-13 floor. The driver
        // gate alone let it through and llama.cpp then failed to load.
        let gpus = vec![nvidia_gpu_cc("580.65", "7.0")];
        let result = get_supported_features("linux".to_string(), vec![], gpus).unwrap();
        assert!(
            result.cuda12,
            "Volta must keep CUDA 12.4 — that build has sm_70 kernels"
        );
        assert!(
            !result.cuda13,
            "CUDA Toolkit 13.0 dropped Volta (7.0); the archive has no sm_70 kernels"
        );
    }

    #[test]
    fn test_pascal_and_maxwell_do_not_get_cuda13() {
        for cc in ["6.1", "5.2"] {
            let gpus = vec![nvidia_gpu_cc("580.65", cc)];
            let result = get_supported_features("linux".to_string(), vec![], gpus).unwrap();
            assert!(!result.cuda13, "CUDA 13 dropped compute capability {cc}");
            assert!(result.cuda12, "CUDA 12.4 still covers {cc}");
        }
    }

    #[test]
    fn test_turing_is_the_cuda13_floor() {
        let gpus = vec![nvidia_gpu_cc("580.65", "7.5")];
        let result = get_supported_features("linux".to_string(), vec![], gpus).unwrap();
        assert!(result.cuda13);
    }

    #[test]
    fn test_blackwell_compute_capability_gets_cuda13() {
        // Guards the lexicographic trap: "10.0" < "7.5" as a string, and a
        // float parse would mangle the minor. Tuple comparison gets it right.
        for cc in ["10.0", "12.0"] {
            let gpus = vec![nvidia_gpu_cc("580.65", cc)];
            let result = get_supported_features("linux".to_string(), vec![], gpus).unwrap();
            assert!(result.cuda13, "compute capability {cc} is well above 7.5");
        }
    }

    #[test]
    fn test_one_old_gpu_vetoes_cuda13_for_the_whole_host() {
        // The reporter's dual-NVIDIA host. llama.cpp enumerates and offloads
        // across every visible CUDA device, so an Ada card next to a Volta one
        // still cannot run the CUDA-13 build.
        let gpus = vec![
            nvidia_gpu_cc("580.65", "8.9"),
            nvidia_gpu_cc("580.65", "7.0"),
        ];
        let result = get_supported_features("linux".to_string(), vec![], gpus).unwrap();
        assert!(!result.cuda13, "one sub-7.5 card must veto the whole host");
        assert!(result.cuda12, "both cards run CUDA 12.4");
    }

    #[test]
    fn test_unknown_compute_capability_does_not_block_cuda13() {
        // `#[serde(default)]` yields an empty string when the field is absent.
        // Unknown must not be read as "old": that would strand a Blackwell
        // host on CUDA 12.4, which has no kernels for it either.
        let gpus = vec![nvidia_gpu_cc("580.65", "")];
        let result = get_supported_features("linux".to_string(), vec![], gpus).unwrap();
        assert!(result.cuda13);
    }

    #[test]
    fn test_nvidia_info_without_compute_capability_still_deserializes() {
        // Regression guard for the serde default: without it the whole `gpus`
        // argument fails to deserialize and the caller ends up with an empty
        // backend list instead of a missing CUDA-13 entry.
        let gpu: GpuInfo = serde_json::from_str(
            r#"{"driver_version":"580.65","nvidia_info":{"index":0},"vulkan_info":null}"#,
        )
        .expect("nvidia_info without compute_capability must deserialize");
        assert_eq!(
            gpu.nvidia_info
                .as_ref()
                .map(|n| n.compute_capability.as_str()),
            Some("")
        );
    }

    // --- Tests for determine_supported_backends ---

    #[test]
    fn test_determine_supported_backends_windows_all() {
        let features = SystemFeatures {
            cuda11: true,
            cuda12: true,
            cuda13: false,
            vulkan: true,
            rocm: false,
        };

        let result =
            determine_supported_backends("windows".to_string(), "x86_64".to_string(), features)
                .unwrap();

        assert!(result.contains(&"windows-x64-cpu".to_string()));
        assert!(result.contains(&"windows-x64-cuda-12.4".to_string()));
        assert!(result.contains(&"windows-x64-vulkan".to_string()));
        // No TurboQuant Windows CUDA-11 build, and cuda13 was not requested.
        assert!(!result.contains(&"windows-x64-cuda-13.3".to_string()));
    }

    #[test]
    fn test_determine_supported_backends_linux_full_matrix() {
        let features = SystemFeatures {
            cuda11: true,
            cuda12: true,
            cuda13: true,
            vulkan: true,
            rocm: true,
        };

        let result =
            determine_supported_backends("linux".to_string(), "x86_64".to_string(), features)
                .unwrap();

        assert!(result.contains(&"linux-x64-cpu".to_string()));
        assert!(result.contains(&"linux-x64-cuda-12.4".to_string()));
        assert!(result.contains(&"linux-x64-cuda-13.3".to_string()));
        assert!(result.contains(&"linux-x64-rocm".to_string()));
        assert!(result.contains(&"linux-x64-vulkan".to_string()));
        // The fork publishes no Linux CUDA-11 build.
        assert!(!result.iter().any(|b| b.contains("cuda-11")));
    }

    #[test]
    fn test_determine_supported_backends_linux_cpu_only_keeps_vulkan_fallback() {
        let features = SystemFeatures {
            cuda11: false,
            cuda12: false,
            cuda13: false,
            vulkan: false,
            rocm: false,
        };

        let result =
            determine_supported_backends("linux".to_string(), "x86_64".to_string(), features)
                .unwrap();

        // The Vulkan build carries a portable CPU path and is what the
        // installer bundles, so it stays offered even with no GPU at all.
        assert_eq!(result, vec!["linux-x64-cpu", "linux-x64-vulkan"]);
    }

    #[test]
    fn test_determine_supported_backends_linux_rocm_absent_without_probe() {
        // An AMD host whose ROCm probe came back negative gets Vulkan, never a
        // ROCm archive it cannot load.
        let features = SystemFeatures {
            cuda11: false,
            cuda12: false,
            cuda13: false,
            vulkan: true,
            rocm: false,
        };

        let result =
            determine_supported_backends("linux".to_string(), "x86_64".to_string(), features)
                .unwrap();

        assert!(!result.contains(&"linux-x64-rocm".to_string()));
        assert!(result.contains(&"linux-x64-vulkan".to_string()));
    }

    #[test]
    fn test_determine_supported_backends_mac_arm() {
        let features = SystemFeatures {
            cuda11: false,
            cuda12: false,
            cuda13: false,
            vulkan: false,
            rocm: false,
        };

        let result =
            determine_supported_backends("macos".to_string(), "arm64".to_string(), features)
                .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "macos-arm64");
    }

    // --- Tests for list_supported_backends ---

    #[tokio::test]
    async fn test_list_supported_backends_sorting_and_dedup() {
        let remote = vec![
            BackendInfo {
                version: "b7523".into(),
                backend: "backend-a".into(),
                order: 1,
            },
            BackendInfo {
                version: "b7523".into(),
                backend: "backend-b".into(),
                order: 1,
            },
        ];

        let local = vec![
            BackendInfo {
                version: "b7523".into(),
                backend: "backend-a".into(),
                order: 0,
            },
            BackendInfo {
                version: "b7524".into(),
                backend: "backend-c".into(),
                order: 2,
            },
        ];

        let result = list_supported_backends(remote, local).await.unwrap();

        assert_eq!(result.len(), 3);

        // Sorted by order desc: b7524(order=2), then b7523 entries (order=1) by backend asc
        assert_eq!(result[0].version, "b7524");
        assert_eq!(result[1].version, "b7523");
        assert_eq!(result[2].version, "b7523");

        assert_eq!(result[1].backend, "backend-a");
        assert_eq!(result[2].backend, "backend-b");
    }

    // --- Tests for parse_backend_version ---
    #[test]
    fn test_parse_backend_version() {
        assert_eq!(parse_backend_version("b7523".to_string()), 7523);
        assert_eq!(parse_backend_version("b7524".to_string()), 7524);
        assert_eq!(parse_backend_version("7525".to_string()), 7525);
        assert_eq!(parse_backend_version("v100".to_string()), 100);
        assert_eq!(parse_backend_version("invalid".to_string()), 0);
        // Note: "v1.0.0" would fail to parse as u32 due to dots, returning 0
        assert_eq!(parse_backend_version("v1.0.0".to_string()), 0);
    }

    // --- Tests for bundled_backend_is_complete ---

    #[test]
    fn test_bundled_backend_is_complete_full() {
        let temp_dir = tempfile::tempdir().unwrap();
        let resource_build = temp_dir.path().join("resource").join("build");
        let target_build = temp_dir.path().join("target").join("build");

        // Resource build/ carries exe + sibling DLL.
        fs::create_dir_all(resource_build.join("bin")).unwrap();
        File::create(resource_build.join("bin").join("llama-server.exe")).unwrap();
        File::create(resource_build.join("bin").join("llama-server-impl.dll")).unwrap();

        // Target mirrors it exactly.
        fs::create_dir_all(target_build.join("bin")).unwrap();
        File::create(target_build.join("bin").join("llama-server.exe")).unwrap();
        File::create(target_build.join("bin").join("llama-server-impl.dll")).unwrap();

        assert!(bundled_backend_is_complete(&resource_build, &target_build));
    }

    #[test]
    fn test_bundled_backend_is_complete_missing_dll() {
        let temp_dir = tempfile::tempdir().unwrap();
        let resource_build = temp_dir.path().join("resource").join("build");
        let target_build = temp_dir.path().join("target").join("build");

        // Resource build/ carries exe + sibling DLL.
        fs::create_dir_all(resource_build.join("bin")).unwrap();
        File::create(resource_build.join("bin").join("llama-server.exe")).unwrap();
        File::create(resource_build.join("bin").join("llama-server-impl.dll")).unwrap();

        // Pre-fix victim: exe present, DLL stranded (missing in target).
        fs::create_dir_all(target_build.join("bin")).unwrap();
        File::create(target_build.join("bin").join("llama-server.exe")).unwrap();

        assert!(!bundled_backend_is_complete(&resource_build, &target_build));
    }

    #[test]
    fn test_bundled_backend_is_complete_missing_target_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        let resource_build = temp_dir.path().join("resource").join("build");
        let target_build = temp_dir.path().join("target").join("build"); // never created

        fs::create_dir_all(resource_build.join("bin")).unwrap();
        File::create(resource_build.join("bin").join("llama-server.exe")).unwrap();

        assert!(!bundled_backend_is_complete(&resource_build, &target_build));
    }

    // --- Filesystem Integration Tests ---

    #[tokio::test]
    async fn test_get_local_installed_backends() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();

        // Structure:
        // root/
        //   b7523/
        //     backend-a/
        //       build/bin/llama-server (exe)
        //     backend-empty/ (no exe)

        let v1_path = root.join("b7523");
        let backend_a = v1_path.join("backend-a");
        let backend_empty = v1_path.join("backend-empty");

        fs::create_dir_all(&backend_a.join("build").join("bin")).unwrap();
        fs::create_dir_all(&backend_empty).unwrap();

        // Create mock executable
        let exe_name = if cfg!(target_os = "windows") {
            "llama-server.exe"
        } else {
            "llama-server"
        };
        File::create(backend_a.join("build").join("bin").join(exe_name)).unwrap();

        let result = get_local_installed_backends(root.to_string_lossy().to_string())
            .await
            .unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].version, "b7523");
        assert_eq!(result[0].backend, "backend-a");
        assert!(
            result[0].order > 0,
            "order should be set from directory mtime"
        );
    }

    #[tokio::test]
    async fn test_get_local_installed_backends_order_by_mtime() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path();

        let exe_name = if cfg!(target_os = "windows") {
            "llama-server.exe"
        } else {
            "llama-server"
        };

        // Create older backend first
        let v_old = root.join("turboquant-macos-arm64-old");
        let backend_old = v_old.join("macos-arm64");
        fs::create_dir_all(&backend_old.join("build").join("bin")).unwrap();
        File::create(backend_old.join("build").join("bin").join(exe_name)).unwrap();

        // Set old mtime (1 second in the past)
        let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(2);
        filetime::set_file_mtime(&backend_old, filetime::FileTime::from_system_time(old_time))
            .unwrap();

        // Create newer backend
        let v_new = root.join("turboquant-macos-arm64-new");
        let backend_new = v_new.join("macos-arm64");
        fs::create_dir_all(&backend_new.join("build").join("bin")).unwrap();
        File::create(backend_new.join("build").join("bin").join(exe_name)).unwrap();

        let result = get_local_installed_backends(root.to_string_lossy().to_string())
            .await
            .unwrap();

        assert_eq!(result.len(), 2);

        let old_entry = result
            .iter()
            .find(|b| b.version == "turboquant-macos-arm64-old")
            .unwrap();
        let new_entry = result
            .iter()
            .find(|b| b.version == "turboquant-macos-arm64-new")
            .unwrap();

        assert!(
            new_entry.order > old_entry.order,
            "Newer backend (order={}) should have higher order than older (order={})",
            new_entry.order,
            old_entry.order
        );
    }

    #[tokio::test]
    async fn test_is_cuda_installed_no_legacy_migration() {
        let backend_dir = tempfile::tempdir().unwrap();
        let jan_data_dir = tempfile::tempdir().unwrap();

        let version = "12.0";
        let os_type = "linux"; // Maps to libcudart.so.12

        // A lib ONLY in the old janhq path must NOT be picked up anymore —
        // TurboQuant bundles cudart in the backend's own build/bin.
        let old_lib_dir = jan_data_dir.path().join("llamacpp").join("lib");
        fs::create_dir_all(&old_lib_dir).unwrap();
        let lib_name = "libcudart.so.12";
        {
            let mut f = File::create(old_lib_dir.join(lib_name)).unwrap();
            f.write_all(b"dummy content").unwrap();
        }

        let installed = is_cuda_installed(
            backend_dir.path().to_string_lossy().to_string(),
            version.to_string(),
            os_type.to_string(),
            jan_data_dir.path().to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert!(
            !installed,
            "Legacy janhq cudart path must not be migrated/used"
        );
        let new_path = backend_dir.path().join("build").join("bin").join(lib_name);
        assert!(!new_path.exists(), "Nothing should be created in build/bin");
    }

    #[tokio::test]
    async fn test_is_cuda_installed_already_exists() {
        let backend_dir = tempfile::tempdir().unwrap();
        let jan_data_dir = tempfile::tempdir().unwrap(); // Empty

        let version = "11.7";
        let os_type = "windows"; // Maps to cudart64_110.dll
        let lib_name = "cudart64_110.dll";

        // Setup New Path directly
        let target_dir = backend_dir.path().join("build").join("bin");
        fs::create_dir_all(&target_dir).unwrap();
        File::create(target_dir.join(lib_name)).unwrap();

        let installed = is_cuda_installed(
            backend_dir.path().to_string_lossy().to_string(),
            version.to_string(),
            os_type.to_string(),
            jan_data_dir.path().to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert!(installed);
    }

    #[tokio::test]
    async fn test_is_cuda_installed_clean_minor_version() {
        let backend_dir = tempfile::tempdir().unwrap();
        let jan_data_dir = tempfile::tempdir().unwrap(); // Empty

        // Clean TurboQuant id carries the toolkit minor; major drives the lib.
        let target_dir = backend_dir.path().join("build").join("bin");
        fs::create_dir_all(&target_dir).unwrap();
        File::create(target_dir.join("cudart64_12.dll")).unwrap();

        let installed = is_cuda_installed(
            backend_dir.path().to_string_lossy().to_string(),
            "12.4".to_string(),
            "windows".to_string(),
            jan_data_dir.path().to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert!(installed, "12.4 should resolve cudart64_12.dll");
    }

    #[tokio::test]
    async fn test_copy_backend_dlls_copies_matching_prefixes_only() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        File::create(src.path().join("cudart64_13.dll")).unwrap();
        File::create(src.path().join("cublas64_13.dll")).unwrap();
        File::create(src.path().join("cublasLt64_13.dll")).unwrap();
        File::create(src.path().join("ggml-cuda.dll")).unwrap();
        File::create(src.path().join("readme.txt")).unwrap();

        let copied = copy_backend_dlls(
            src.path().to_string_lossy().to_string(),
            dst.path().to_string_lossy().to_string(),
            vec!["cudart".into(), "cublas".into()],
        )
        .await
        .unwrap();

        assert_eq!(copied, 3);
        assert!(dst.path().join("cudart64_13.dll").exists());
        assert!(dst.path().join("cublas64_13.dll").exists());
        assert!(dst.path().join("cublasLt64_13.dll").exists());
        assert!(!dst.path().join("ggml-cuda.dll").exists());
        // Source must remain intact — we copy, never move.
        assert!(src.path().join("cudart64_13.dll").exists());
    }

    // --- Tests for find_latest_version_for_backend ---

    #[test]
    fn test_find_latest_version_for_backend() {
        // Clean Linux id: TurboQuant tags are not numeric, so install `order`
        // (descending) decides — highest order wins.
        let backends = vec![
            BackendInfo {
                version: "turboquant-linux-x64-vulkan-aaaa".into(),
                backend: "linux-x64-vulkan".into(),
                order: 2,
            },
            BackendInfo {
                version: "turboquant-linux-x64-vulkan-bbbb".into(),
                backend: "linux-x64-vulkan".into(),
                order: 3,
            },
            BackendInfo {
                version: "turboquant-linux-x64-vulkan-cccc".into(),
                backend: "linux-x64-vulkan".into(),
                order: 1,
            },
        ];

        let result = find_latest_version_for_backend(backends, "linux-x64-vulkan".to_string());
        assert_eq!(
            result,
            Some("turboquant-linux-x64-vulkan-bbbb/linux-x64-vulkan".to_string())
        );
    }

    // Unified tags are monotonic, so they must beat install order the way
    // numeric upstream tags always have — a freshly downloaded older release
    // must not shadow a newer one.
    #[test]
    fn test_find_latest_version_prefers_the_newest_unified_release() {
        let backends = vec![
            BackendInfo {
                version: "b10018-1.3.0".into(),
                backend: "linux-x64-rocm".into(),
                order: 1,
            },
            BackendInfo {
                version: "b10018-1.2.9".into(),
                backend: "linux-x64-rocm".into(),
                order: 9,
            },
            BackendInfo {
                version: "b9900-1.4.0".into(),
                backend: "linux-x64-rocm".into(),
                order: 8,
            },
        ];

        let result = find_latest_version_for_backend(backends, "linux-x64-rocm".to_string());
        assert_eq!(result, Some("b10018-1.3.0/linux-x64-rocm".to_string()));
    }

    // Legacy per-variant folders survive an upgrade, and moving to the unified
    // train is always forward.
    #[test]
    fn test_find_latest_version_ranks_unified_above_legacy_tags() {
        let backends = vec![
            BackendInfo {
                version: "turboquant-linux-x64-vulkan-bbbb".into(),
                backend: "linux-x64-vulkan".into(),
                order: 99,
            },
            BackendInfo {
                version: "b10018-1.3.0".into(),
                backend: "linux-x64-vulkan".into(),
                order: 1,
            },
        ];

        let result = find_latest_version_for_backend(backends, "linux-x64-vulkan".to_string());
        assert_eq!(result, Some("b10018-1.3.0/linux-x64-vulkan".to_string()));
    }

    #[test]
    fn test_find_latest_version_for_windows_backend_uses_version_not_order() {
        // Legacy janhq-style Windows ids carry numeric bXXXX tags → numeric sort
        // still wins over install order (back-compat).
        let backends = vec![
            BackendInfo {
                version: "b7524".into(),
                backend: "windows-x64-cuda-12.4".into(),
                order: 1_800_000_000,
            },
            BackendInfo {
                version: "b7525".into(),
                backend: "windows-x64-cuda-12.4".into(),
                order: 0,
            },
        ];

        let result = find_latest_version_for_backend(backends, "windows-x64-cuda-12.4".to_string());
        assert_eq!(result, Some("b7525/windows-x64-cuda-12.4".to_string()));
    }

    #[test]
    fn test_find_latest_version_for_backend_with_migration() {
        // A legacy Linux id and a clean one both map to `linux-x64-vulkan`, so a
        // query for the clean type matches both; highest order wins.
        let backends = vec![
            BackendInfo {
                version: "turboquant-linux-x64-vulkan-aaaa".into(),
                backend: "linux-avx2-x64".into(),
                order: 1,
            },
            BackendInfo {
                version: "turboquant-linux-x64-vulkan-bbbb".into(),
                backend: "linux-x64-vulkan".into(),
                order: 2,
            },
        ];

        let result = find_latest_version_for_backend(backends, "linux-x64-vulkan".to_string());
        assert_eq!(
            result,
            Some("turboquant-linux-x64-vulkan-bbbb/linux-x64-vulkan".to_string())
        );
    }

    // --- Tests for check_backend_for_updates ---

    #[tokio::test]
    async fn test_check_backend_for_updates_needs_update() {
        let current = "turboquant-macos-arm64-e3dad20/macos-arm64".to_string();
        let available = vec![
            BackendInfo {
                version: "turboquant-macos-arm64-e3dad20".into(),
                backend: "macos-arm64".into(),
                order: 1,
            },
            BackendInfo {
                version: "turboquant-macos-arm64-18a8ef1".into(),
                backend: "macos-arm64".into(),
                order: 2,
            },
        ];

        let result = check_backend_for_updates(current, available).await.unwrap();

        assert!(result.update_needed);
        assert_eq!(result.new_version, "turboquant-macos-arm64-18a8ef1");
        assert_eq!(
            result.target_backend,
            Some("turboquant-macos-arm64-18a8ef1/macos-arm64".to_string())
        );
    }

    #[tokio::test]
    async fn test_check_backend_for_updates_already_latest() {
        let current = "turboquant-macos-arm64-18a8ef1/macos-arm64".to_string();
        let available = vec![
            BackendInfo {
                version: "turboquant-macos-arm64-e3dad20".into(),
                backend: "macos-arm64".into(),
                order: 1,
            },
            BackendInfo {
                version: "turboquant-macos-arm64-18a8ef1".into(),
                backend: "macos-arm64".into(),
                order: 2,
            },
        ];

        let result = check_backend_for_updates(current, available).await.unwrap();

        assert!(!result.update_needed);
        assert_eq!(result.new_version, "0");
        assert_eq!(result.target_backend, None);
    }

    #[tokio::test]
    async fn test_check_backend_for_updates_windows_uses_version_not_order() {
        let current = "b7524/windows-x64-cuda-12.4".to_string();
        let available = vec![
            BackendInfo {
                version: "b7524".into(),
                backend: "windows-x64-cuda-12.4".into(),
                order: 1_800_000_000,
            },
            BackendInfo {
                version: "b7525".into(),
                backend: "windows-x64-cuda-12.4".into(),
                order: 0,
            },
        ];

        let result = check_backend_for_updates(current, available).await.unwrap();

        assert!(result.update_needed);
        assert_eq!(result.new_version, "b7525");
        assert_eq!(
            result.target_backend,
            Some("b7525/windows-x64-cuda-12.4".to_string())
        );
    }

    // --- Tests for validate_backend_string ---

    #[test]
    fn test_validate_backend_string_valid() {
        let result = validate_backend_string("b7524/linux-common_cpus-x64".to_string()).unwrap();
        assert_eq!(result.0, "b7524");
        assert_eq!(result.1, "linux-common_cpus-x64");
    }

    #[test]
    fn test_validate_backend_string_invalid() {
        let result = validate_backend_string("invalid-format".to_string());
        assert!(result.is_err());
    }

    // --- Tests for should_migrate_backend ---

    #[test]
    fn test_should_migrate_backend_needs_migration() {
        // Legacy Linux id maps to the clean `linux-x64-vulkan`; the clean type is
        // available, so migration is required.
        let old_backend = "linux-avx2-x64".to_string();
        let available = vec![BackendInfo {
            version: "turboquant-linux-x64-vulkan-aaaa".into(),
            backend: "linux-x64-vulkan".into(),
            order: 1,
        }];

        let result = should_migrate_backend(old_backend, available).unwrap();
        assert_eq!(result, Some("linux-x64-vulkan".to_string()));
    }

    #[test]
    fn test_should_migrate_backend_no_migration_needed() {
        // Clean id maps to itself → nothing to migrate.
        let new_backend = "linux-x64-vulkan".to_string();
        let available = vec![BackendInfo {
            version: "turboquant-linux-x64-vulkan-aaaa".into(),
            backend: "linux-x64-vulkan".into(),
            order: 1,
        }];

        let result = should_migrate_backend(new_backend, available).unwrap();
        assert_eq!(result, None);
    }
}
