use super::types::GgufMetadata;
use super::utils::{estimate_kv_cache_internal, read_gguf_metadata_internal};
use crate::gguf::types::{KVCacheError, KVCacheEstimate, ModelSupportStatus};
use std::collections::HashMap;
use std::fs;
use tauri_plugin_hardware::get_system_info;
/// Read GGUF metadata from a model file
#[tauri::command]
pub async fn read_gguf_metadata(path: String) -> Result<GgufMetadata, String> {
    return read_gguf_metadata_internal(path).await;
}

#[tauri::command]
pub async fn estimate_kv_cache_size(
    meta: HashMap<String, String>,
    ctx_size: Option<u64>,
) -> Result<KVCacheEstimate, KVCacheError> {
    estimate_kv_cache_internal(meta, ctx_size).await
}

#[tauri::command]
pub async fn get_model_size(path: String) -> Result<u64, String> {
    if path.starts_with("https://") {
        // Handle remote URL
        let client = reqwest::Client::new();
        let response = client
            .head(&path)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch HEAD request: {}", e))?;

        if let Some(content_length) = response.headers().get("content-length") {
            let content_length_str = content_length
                .to_str()
                .map_err(|e| format!("Invalid content-length header: {}", e))?;
            content_length_str
                .parse::<u64>()
                .map_err(|e| format!("Failed to parse content-length: {}", e))
        } else {
            Ok(0)
        }
    } else {
        // Handle local file using standard fs
        let metadata =
            fs::metadata(&path).map_err(|e| format!("Failed to get file metadata: {}", e))?;
        Ok(metadata.len())
    }
}

/// Headroom left to the OS, the app, and llama.cpp's own allocations on top of
/// the weights + KV cache we account for.
const RESERVE_BYTES: u64 = 2288490189;

/// One GPU's contribution to the memory a model can be loaded into.
#[derive(Debug, Clone, Copy)]
pub(crate) struct GpuMemory {
    pub total_bytes: u64,
    /// Whether this GPU's memory is carved out of system RAM (an integrated
    /// GPU) rather than being its own pool.
    pub integrated: bool,
}

/// Whether a GPU's memory comes out of system RAM.
///
/// Vulkan reports this directly (`IntegratedGpu`), and that is the only source
/// trusted here: guessing from the vendor would misclassify discrete Intel Arc
/// cards, and over-reporting memory is exactly the failure being fixed. Without
/// Vulkan data the GPU is treated as discrete, which matches the previous
/// behaviour rather than shrinking anyone's budget on a hunch.
fn is_integrated_gpu(gpu: &tauri_plugin_hardware::GpuInfo) -> bool {
    gpu.vulkan_info
        .as_ref()
        .is_some_and(|v| v.device_type.eq_ignore_ascii_case("IntegratedGpu"))
}

/// What a model is allowed to occupy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MemoryBudget {
    /// Fits here → runs entirely on the GPU.
    pub usable_vram: u64,
    /// Fits here → runs at all, spilling to system RAM.
    pub usable_total: u64,
}

/// Work out how much memory a model may use.
///
/// The subtlety is integrated graphics: its "VRAM" is a slice of the same
/// system RAM, so adding the two together counts it twice. That is how a
/// 16 GB laptop with an Intel UHD came out with a 25 GB budget, was told a
/// 17 GB model would fit, and then died allocating it — the OOM users kept
/// hitting. Only a discrete GPU adds memory of its own.
pub(crate) fn memory_budget(total_ram_bytes: u64, gpus: &[GpuMemory]) -> MemoryBudget {
    let total_vram: u64 = gpus.iter().map(|g| g.total_bytes).sum();

    if gpus.is_empty() {
        // Unified memory (Apple Silicon): no GPU is enumerated and RAM *is* the
        // VRAM, so there is one pool and nothing to add up.
        let usable = total_ram_bytes.saturating_sub(RESERVE_BYTES);
        return MemoryBudget {
            usable_vram: usable,
            usable_total: usable,
        };
    }

    let discrete_vram: u64 = gpus
        .iter()
        .filter(|g| !g.integrated)
        .map(|g| g.total_bytes)
        .sum();

    MemoryBudget {
        usable_vram: total_vram.saturating_sub(RESERVE_BYTES),
        usable_total: total_ram_bytes.saturating_sub(RESERVE_BYTES)
            + discrete_vram.saturating_sub(RESERVE_BYTES),
    }
}

#[tauri::command]
pub async fn is_model_supported(
    path: String,
    ctx_size: Option<u32>,
) -> Result<ModelSupportStatus, String> {
    // Get model size
    let model_size = get_model_size(path.clone()).await?;

    // Get system info
    let system_info = get_system_info();

    log::info!("modelSize: {}", model_size);

    // Read GGUF metadata
    let gguf = read_gguf_metadata(path.clone()).await?;

    // Calculate KV cache size
    let kv_cache_size = if let Some(ctx_size) = ctx_size {
        log::info!("Using ctx_size: {}", ctx_size);
        estimate_kv_cache_internal(gguf.metadata, Some(ctx_size as u64))
            .await
            .map_err(|e| e.to_string())?
            .size
    } else {
        estimate_kv_cache_internal(gguf.metadata, None)
            .await
            .map_err(|e| e.to_string())?
            .size
    };

    // Total memory consumption = model weights + kvcache
    let total_required = model_size + kv_cache_size;
    log::info!(
        "isModelSupported: Total memory requirement: {} for {}; Got kvCacheSize: {} from BE",
        total_required,
        path,
        kv_cache_size
    );

    let total_ram_bytes = system_info.total_memory * 1024 * 1024;
    let gpus: Vec<GpuMemory> = system_info
        .gpus
        .iter()
        .map(|g| GpuMemory {
            total_bytes: g.total_memory * 1024 * 1024,
            integrated: is_integrated_gpu(g),
        })
        .collect();

    let budget = memory_budget(total_ram_bytes, &gpus);

    log::info!(
        "System RAM: {} bytes; GPUs: {}",
        total_ram_bytes,
        if gpus.is_empty() {
            "none enumerated (unified memory)".to_string()
        } else {
            gpus.iter()
                .map(|g| {
                    format!(
                        "{} bytes ({})",
                        g.total_bytes,
                        if g.integrated {
                            "integrated, shares system RAM"
                        } else {
                            "discrete"
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        }
    );
    log::info!("Usable total memory: {} bytes", budget.usable_total);
    log::info!("Usable VRAM: {} bytes", budget.usable_vram);
    log::info!("Required: {} bytes", &total_required);

    let usable_vram = budget.usable_vram;
    let usable_total_memory = budget.usable_total;


    // Check if model fits in total memory at all (this is the hard limit)
    if total_required > usable_total_memory {
        return Ok(ModelSupportStatus::Red); // Truly impossible to run
    }

    // Check if everything fits in VRAM (ideal case)
    if total_required <= usable_vram {
        return Ok(ModelSupportStatus::Green);
    }

    // If we get here, it means:
    // - Total requirement fits in combined memory
    // - But doesn't fit entirely in VRAM
    // This is the CPU-GPU hybrid scenario
    Ok(ModelSupportStatus::Yellow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;

    fn discrete(bytes: u64) -> GpuMemory {
        GpuMemory {
            total_bytes: bytes,
            integrated: false,
        }
    }

    fn integrated(bytes: u64) -> GpuMemory {
        GpuMemory {
            total_bytes: bytes,
            integrated: true,
        }
    }

    #[test]
    fn integrated_vram_is_not_counted_on_top_of_system_ram() {
        // The reported OOM: 16 GB laptop, Intel UHD advertising ~8 GB of shared
        // memory, asked to load a model needing ~17 GB. Counting both pools said
        // ~25 GB was available and let the load through.
        let budget = memory_budget(16 * GB, &[integrated(8 * GB)]);

        assert!(
            budget.usable_total < 16 * GB,
            "integrated VRAM must not add to RAM, got {} bytes",
            budget.usable_total
        );
        assert!(
            budget.usable_total < 17 * GB,
            "a 17 GB model must not be reported as loadable"
        );
    }

    #[test]
    fn discrete_vram_adds_to_system_ram() {
        // A real second pool: the model can genuinely spill across both.
        let budget = memory_budget(16 * GB, &[discrete(11 * GB)]);

        assert_eq!(
            budget.usable_total,
            (16 * GB - RESERVE_BYTES) + (11 * GB - RESERVE_BYTES)
        );
        assert_eq!(budget.usable_vram, 11 * GB - RESERVE_BYTES);
    }

    #[test]
    fn unified_memory_reports_one_pool() {
        // Apple Silicon: no GPU is enumerated and RAM is the VRAM. Counting it
        // once as both is correct here — and it must not come out as zero.
        let budget = memory_budget(16 * GB, &[]);

        assert_eq!(budget.usable_vram, 16 * GB - RESERVE_BYTES);
        assert_eq!(budget.usable_total, budget.usable_vram);
    }

    #[test]
    fn a_discrete_gpu_beside_an_integrated_one_contributes_alone() {
        let budget = memory_budget(32 * GB, &[integrated(4 * GB), discrete(24 * GB)]);

        assert_eq!(
            budget.usable_total,
            (32 * GB - RESERVE_BYTES) + (24 * GB - RESERVE_BYTES)
        );
        // Both pools can still hold weights, so VRAM-only capacity counts both.
        assert_eq!(budget.usable_vram, 28 * GB - RESERVE_BYTES);
    }

    #[test]
    fn a_machine_smaller_than_the_reserve_offers_nothing() {
        let budget = memory_budget(1 * GB, &[integrated(512 * 1024 * 1024)]);

        assert_eq!(budget.usable_total, 0);
        assert_eq!(budget.usable_vram, 0);
    }
}
