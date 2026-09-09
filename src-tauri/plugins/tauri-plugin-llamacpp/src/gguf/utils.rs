use crate::gguf::helpers;
use crate::gguf::types::{GgufMetadata, KVCacheError, KVCacheEstimate};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;

// read gguf metadata
pub async fn read_gguf_metadata_internal(path: String) -> Result<GgufMetadata, String> {
    if path.starts_with("http://") || path.starts_with("https://") {
        // Remote: read in 2MB chunks until successful
        let client = reqwest::Client::new();
        let chunk_size = 2 * 1024 * 1024; // Fixed 2MB chunks
        let max_total_size = 120 * 1024 * 1024; // Don't exceed 120MB total
        let mut total_downloaded = 0;
        let mut accumulated_data = Vec::new();

        while total_downloaded < max_total_size {
            let start = total_downloaded;
            let end = std::cmp::min(start + chunk_size - 1, max_total_size - 1);

            let resp = client
                .get(&path)
                .header("Range", format!("bytes={}-{}", start, end))
                .send()
                .await
                .map_err(|e| format!("Failed to fetch chunk {}-{}: {}", start, end, e))?;

            let chunk_data = resp
                .bytes()
                .await
                .map_err(|e| format!("Failed to read chunk response: {}", e))?;

            accumulated_data.extend_from_slice(&chunk_data);
            total_downloaded += chunk_data.len();

            // Try parsing after each chunk
            let cursor = std::io::Cursor::new(&accumulated_data);
            if let Ok(metadata) = helpers::read_gguf_metadata(cursor) {
                return Ok(metadata);
            }

            // If we got less data than expected, we've reached EOF
            if chunk_data.len() < chunk_size {
                break;
            }
        }
        Err("Could not parse GGUF metadata from downloaded data".to_string())
    } else {
        // Local: use streaming file reader
        let file =
            File::open(&path).map_err(|e| format!("Failed to open local file {}: {}", path, e))?;
        let reader = BufReader::new(file);

        helpers::read_gguf_metadata(reader)
            .map_err(|e| format!("Failed to parse GGUF metadata: {}", e))
    }
}

/// Bits one KV-cache element occupies under a llama.cpp `cache_type_*`.
///
/// The block quants carry a scale per 32 elements, which is where the half
/// bits come from (`q8_0` is 32 × 8 bits + 16 bits of scale = 8.5 bits per
/// element). The TurboQuant types are the fork's own and are named by their
/// width. An unknown or absent type is read as fp16 — the only thing the
/// estimate assumed before it could be told (ATO-465).
pub fn kv_cache_bits_per_element(cache_type: Option<&str>) -> f64 {
    match cache_type.map(|t| t.trim().to_ascii_lowercase()).as_deref() {
        Some("f32") => 32.0,
        Some("f16") | Some("bf16") => 16.0,
        Some("q8_0") => 8.5,
        Some("q5_1") => 6.0,
        Some("q5_0") => 5.5,
        Some("q4_1") => 5.0,
        Some("q4_0") | Some("iq4_nl") => 4.5,
        Some("turbo4") => 4.0,
        Some("turbo3") => 3.0,
        Some("turbo2") => 2.0,
        _ => 16.0,
    }
}

/// Estimate KVCache size from a given metadata.
///
/// `cache_type_k` / `cache_type_v` are the llama.cpp cache types the model
/// will be loaded with. Without them the estimate assumed fp16, which with
/// the fork's `turbo3` default overstated the cache roughly five-fold — and
/// the fits/doesn't-fit dot went red on models that loaded fine.
pub async fn estimate_kv_cache_internal(
    meta: HashMap<String, String>,
    ctx_size: Option<u64>,
    cache_type_k: Option<&str>,
    cache_type_v: Option<&str>,
) -> Result<KVCacheEstimate, KVCacheError> {
    log::info!(
        "Received ctx_size parameter: {:?}, cache types: {:?}/{:?}",
        ctx_size,
        cache_type_k,
        cache_type_v
    );
    let arch = meta
        .get("general.architecture")
        .ok_or(KVCacheError::ArchitectureNotFound)?;

    // Number of layers
    let n_layer_key = format!("{}.block_count", arch);
    let n_layer = meta
        .get(&n_layer_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .ok_or(KVCacheError::BlockCountInvalid)?;

    // Attention heads (use kv heads if present, else full heads)
    let n_head_key = format!("{}.attention.head_count", arch);
    let n_head_kv_key = format!("{}.attention.head_count_kv", arch);
    let n_head = meta
        .get(&n_head_kv_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or_else(|| {
            meta.get(&n_head_key)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0)
        });
    if n_head == 0 {
        return Err(KVCacheError::HeadCountInvalid);
    }

    // Key/value dimensions
    let key_len_key = format!("{}.attention.key_length", arch);
    let val_len_key = format!("{}.attention.value_length", arch);

    let mut key_len = meta
        .get(&key_len_key)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let mut val_len = meta
        .get(&val_len_key)
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    // Fallback: calculate from embedding_length if key/val lengths not found
    if key_len == 0 || val_len == 0 {
        let emb_len_key = format!("{}.embedding_length", arch);
        let emb_len = meta
            .get(&emb_len_key)
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        if emb_len > 0 && n_head > 0 {
            // For most transformers: head_dim = embedding_length / total_heads
            let total_heads = meta
                .get(&n_head_key)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(n_head);

            let head_dim = emb_len / total_heads;
            key_len = head_dim;
            val_len = head_dim;

            log::info!(
                "Calculated key_len and val_len from embedding_length: {} / {} heads = {} per head",
                emb_len,
                total_heads,
                head_dim
            );
        }
    }

    if key_len == 0 || val_len == 0 {
        return Err(KVCacheError::EmbeddingLengthInvalid);
    }

    // Context length
    let max_ctx_key = format!("{}.context_length", arch);
    let max_ctx = meta
        .get(&max_ctx_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .ok_or(KVCacheError::ContextLengthInvalid)?;
    let ctx_len = ctx_size.map(|size| size.min(max_ctx)).unwrap_or(max_ctx);

    // Sliding window if present
    let sliding_key = format!("{}.attention.sliding_window", arch);
    let sliding_window = meta
        .get(&sliding_key)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&n| n > 0);

    // Per-token KV size, at the widths the cache will actually use.
    let bits_k = kv_cache_bits_per_element(cache_type_k);
    let bits_v = kv_cache_bits_per_element(cache_type_v);
    let bits_per_token =
        (n_layer * n_head) as f64 * (key_len as f64 * bits_k + val_len as f64 * bits_v);
    let kv_per_token = (bits_per_token / 8.0).ceil() as u64;

    // Pure full-attention cost
    let full_cost = ctx_len * kv_per_token;

    // Pure sliding-window cost (tiny, only keeps last W tokens)
    let sliding_cost = sliding_window.map(|w| w * kv_per_token);

    // Middle estimate: average of sliding + full if sliding_window is present
    let chosen_size = if let Some(slide) = sliding_cost {
        let middle = (full_cost + slide) / 2;
        log::info!(
            "KV estimates -> sliding: {} bytes (~{:.2} MB), full: {} bytes (~{:.2} MB), middle: {} bytes (~{:.2} MB)",
            slide,
            slide as f64 / (1024.0 * 1024.0),
            full_cost,
            full_cost as f64 / (1024.0 * 1024.0),
            middle,
            middle as f64 / (1024.0 * 1024.0)
        );
        middle
    } else {
        log::info!(
            "KV estimate (no SWA detected) -> full: {} bytes (~{:.2} MB)",
            full_cost,
            full_cost as f64 / (1024.0 * 1024.0)
        );
        full_cost
    };

    Ok(KVCacheEstimate {
        size: chosen_size,
        per_token_size: kv_per_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(layers: u64, heads: u64, head_dim: u64, ctx: u64) -> HashMap<String, String> {
        HashMap::from([
            ("general.architecture".to_string(), "llama".to_string()),
            ("llama.block_count".to_string(), layers.to_string()),
            ("llama.attention.head_count".to_string(), heads.to_string()),
            ("llama.attention.head_count_kv".to_string(), heads.to_string()),
            ("llama.attention.key_length".to_string(), head_dim.to_string()),
            ("llama.attention.value_length".to_string(), head_dim.to_string()),
            ("llama.context_length".to_string(), ctx.to_string()),
        ])
    }

    #[test]
    fn unknown_or_absent_cache_type_reads_as_fp16() {
        assert_eq!(kv_cache_bits_per_element(None), 16.0);
        assert_eq!(kv_cache_bits_per_element(Some("something-new")), 16.0);
        assert_eq!(kv_cache_bits_per_element(Some("F16")), 16.0);
    }

    #[test]
    fn block_quants_carry_their_scale_bits() {
        assert_eq!(kv_cache_bits_per_element(Some("q8_0")), 8.5);
        assert_eq!(kv_cache_bits_per_element(Some("q4_0")), 4.5);
        assert_eq!(kv_cache_bits_per_element(Some("turbo3")), 3.0);
    }

    #[tokio::test]
    async fn fp16_matches_the_old_two_bytes_per_element() {
        // 32 layers × 8 heads × (128 + 128) × 2 bytes = 1 MiB per token.
        let est = estimate_kv_cache_internal(meta(32, 8, 128, 4096), Some(4096), None, None)
            .await
            .unwrap();
        assert_eq!(est.per_token_size, 32 * 8 * 256 * 2);
        assert_eq!(est.size, 4096 * est.per_token_size);
    }

    #[tokio::test]
    async fn turbo3_is_three_sixteenths_of_fp16() {
        // The fork's default. Estimated as fp16 it was overstated ~5×, and the
        // fits/doesn't-fit dot went red on models that loaded.
        let fp16 = estimate_kv_cache_internal(meta(32, 8, 128, 4096), Some(4096), None, None)
            .await
            .unwrap();
        let turbo = estimate_kv_cache_internal(
            meta(32, 8, 128, 4096),
            Some(4096),
            Some("turbo3"),
            Some("turbo3"),
        )
        .await
        .unwrap();
        assert_eq!(turbo.per_token_size * 16, fp16.per_token_size * 3);
    }

    #[tokio::test]
    async fn keys_and_values_may_differ() {
        let est = estimate_kv_cache_internal(
            meta(1, 1, 128, 1),
            Some(1),
            Some("f16"),
            Some("q8_0"),
        )
        .await
        .unwrap();
        // 128 × 16 bits + 128 × 8.5 bits = 3136 bits = 392 bytes.
        assert_eq!(est.per_token_size, 392);
    }
}
