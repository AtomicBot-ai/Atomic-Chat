//! Golden fixtures for `atomic-chat-core`'s MLX runtime (PLAN.md §5.1, stage 5).
//!
//! ```sh
//! cargo test --manifest-path src-tauri/plugins/tauri-plugin-mlx/Cargo.toml -- --ignored dump_fixtures
//! ```
//!
//! Writes `<repo>/tests/fixtures/core-contracts/mlx-{args,errors}/<case>.json` and an `index.json`
//! per set. `args` pins the exact argv `build_mlx_server_args` gives mlx-server; the one path that
//! depends on the filesystem (a weight *file* collapses to its directory) is built in a temporary
//! folder and written with the `<tmp>` placeholder. `errors` pins `MlxError::from_stderr`.

use super::*;
use crate::error::MlxError;
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn git_head(root: &PathBuf) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn config(
    ctx_size: i32,
    draft_model_path: &str,
    block_size: i32,
    draft_kind: &str,
    kv_bits: f32,
    kv_quant_scheme: &str,
) -> MlxConfig {
    MlxConfig {
        ctx_size,
        draft_model_path: draft_model_path.to_string(),
        block_size,
        draft_kind: draft_kind.to_string(),
        kv_bits,
        kv_quant_scheme: kv_quant_scheme.to_string(),
    }
}

fn write_set(out: &PathBuf, set: &str, source: &str, commit: &str, comparator: &str, note: &str, docs: Vec<(String, serde_json::Value)>) {
    let dir = out.join(set);
    fs::create_dir_all(&dir).unwrap();
    let mut names = Vec::new();
    for (name, doc) in docs {
        fs::write(
            dir.join(format!("{name}.json")),
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
        names.push(name);
    }
    let index = json!({
        "source": { "file": source, "commit": commit },
        "comparator": comparator,
        "note": note,
        "cases": names,
    });
    fs::write(dir.join("index.json"), serde_json::to_string_pretty(&index).unwrap() + "\n").unwrap();
}

#[test]
#[ignore]
fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts");
    let commit = git_head(&root);
    let source = "src-tauri/plugins/tauri-plugin-mlx/src/commands.rs";

    // ── argv ────────────────────────────────────────────────────────────────
    let tmp = std::env::temp_dir().join(format!("atomic-mlx-fixture-{}", std::process::id()));
    fs::create_dir_all(tmp.join("target")).unwrap();
    fs::create_dir_all(tmp.join("draft")).unwrap();
    fs::write(tmp.join("target/model.safetensors"), b"x").unwrap();
    fs::write(tmp.join("draft/model.safetensors"), b"x").unwrap();
    let tmp_str = tmp.to_string_lossy().to_string();
    let target_file = format!("{tmp_str}/target/model.safetensors");
    let draft_file = format!("{tmp_str}/draft/model.safetensors");

    let arg_cases: Vec<(&str, String, u16, MlxConfig)> = vec![
        ("basic_directory", "/models/qwen".into(), 3123, config(0, "", 0, "", 0.0, "")),
        ("ctx_size_32768", "/models/qwen".into(), 3123, config(32768, "", 0, "", 0.0, "")),
        ("ctx_size_negative_omitted", "/models/qwen".into(), 3123, config(-1, "", 0, "", 0.0, "")),
        ("weight_file_collapses_to_directory", target_file.clone(), 3999, config(8192, "", 0, "", 0.0, "")),
        ("missing_weight_file_kept_verbatim", "/nope/model.safetensors".into(), 3000, config(0, "", 0, "", 0.0, "")),
        ("draft_dflash_block_16", "/models/qwen".into(), 3123, config(4096, "/drafts/z-lab", 16, "dflash", 0.0, "")),
        ("draft_mtp_block_4", "/models/gemma".into(), 3123, config(0, "/drafts/mtp", 4, "mtp", 0.0, "")),
        ("draft_eagle3_block_0_omits_block_size", "/models/gemma".into(), 3123, config(0, "/drafts/eagle", 0, "eagle3", 0.0, "")),
        ("draft_kind_empty_defaults_to_dflash", "/models/qwen".into(), 3123, config(0, "/drafts/x", 8, "", 0.0, "")),
        ("draft_kind_unknown_defaults_to_dflash", "/models/qwen".into(), 3123, config(0, "/drafts/x", 8, "medusa", 0.0, "")),
        ("draft_file_collapses_to_directory", "/models/qwen".into(), 3123, config(0, &draft_file, 16, "dflash", 0.0, "")),
        ("block_size_without_draft_ignored", "/models/qwen".into(), 3123, config(0, "", 16, "mtp", 0.0, "")),
        ("kv_turboquant_3_5", "/models/qwen".into(), 3123, config(0, "", 0, "", 3.5, "turboquant")),
        ("kv_uniform_8_integral", "/models/qwen".into(), 3123, config(0, "", 0, "", 8.0, "uniform")),
        ("kv_scheme_off_ignored", "/models/qwen".into(), 3123, config(0, "", 0, "", 4.0, "off")),
        ("kv_scheme_empty_ignored", "/models/qwen".into(), 3123, config(0, "", 0, "", 4.0, "")),
        ("kv_bits_zero_ignored", "/models/qwen".into(), 3123, config(0, "", 0, "", 0.0, "turboquant")),
        ("kv_bits_negative_ignored", "/models/qwen".into(), 3123, config(0, "", 0, "", -2.0, "uniform")),
        ("everything", "/models/qwen".into(), 3500, config(65536, "/drafts/mtp", 4, "mtp", 3.5, "turboquant")),
        ("path_with_spaces_and_unicode", "/Users/Юзер/My Models/qwen 3".into(), 3123, config(0, "", 0, "", 0.0, "")),
    ];
    let placeholder = |s: &str| s.replace(&tmp_str, "<tmp>");
    let arg_docs = arg_cases
        .into_iter()
        .map(|(name, model_path, port, cfg)| {
            let argv: Vec<String> = build_mlx_server_args(&model_path, port, &cfg)
                .iter()
                .map(|a| placeholder(a))
                .collect();
            let doc = json!({
                "name": name,
                "source": { "file": source, "commit": commit, "provider": "mlx" },
                "comparator": "argv-exact",
                "input": {
                    "model_path": placeholder(&model_path),
                    "port": port,
                    "config": {
                        "ctx_size": cfg.ctx_size,
                        "draft_model_path": placeholder(&cfg.draft_model_path),
                        "block_size": cfg.block_size,
                        "draft_kind": cfg.draft_kind,
                        "kv_bits": cfg.kv_bits,
                        "kv_quant_scheme": cfg.kv_quant_scheme,
                    },
                },
                "expected": { "argv": argv },
            });
            (name.to_string(), doc)
        })
        .collect();
    write_set(
        &out,
        "mlx-args",
        source,
        &commit,
        "argv-exact",
        "expected.argv = build_mlx_server_args(model_path, port, config), order significant. <tmp> is a temporary folder in which target/model.safetensors and draft/model.safetensors exist as files; every other path does not exist. kv_bits is f32::to_string (8.0 -> \"8\").",
        arg_docs,
    );
    fs::remove_dir_all(&tmp).ok();

    // ── errors ──────────────────────────────────────────────────────────────
    let error_cases: Vec<(&str, &str)> = vec![
        ("oom_out_of_memory", "RuntimeError: out of memory"),
        ("oom_failed_to_allocate", "failed to allocate 1024 bytes"),
        ("oom_insufficient_memory", "Insufficient Memory"),
        ("oom_metal_malloc", "[metal::malloc] Attempting to allocate 18253611008 bytes which is greater than the maximum allowed buffer size of 17179869184 bytes."),
        ("oom_maximum_allowed_buffer_size", "exceeds the maximum allowed buffer size"),
        ("oom_recommended_max_working_set", "larger than the recommended max working set size"),
        ("oom_recommended_working_set", "above recommended working set size"),
        ("oom_metal_command_buffer", "[METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)"),
        ("oom_device_memory", "vk: ErrorOutOfDeviceMemory"),
        ("arch_model_type_not_supported", "ValueError: Model type lfm2_moe not supported."),
        ("arch_model_type_without_not_supported", "Model type lfm2_moe loaded"),
        ("arch_unknown_model_type", "unknown model type: foo"),
        ("arch_missing_mlx_vlm_module", "No module named 'mlx_vlm.models.foo'"),
        ("arch_missing_drafter_module", "Model type gemma4_unified not supported. Error: No module named 'mlx_vlm.speculative.drafters.gemma4_unified'"),
        ("arch_missing_mlx_lm_module", "ModuleNotFoundError: No module named 'mlx_lm.models.qwen3_5_text'"),
        ("arch_switch_mlp_key", "KeyError: 'model.layers.0.feed_forward.switch_mlp.gate_proj.weight'"),
        ("precedence_oom_before_arch", "unknown model type: x\nout of memory"),
        ("case_insensitive", "OUT OF MEMORY"),
        ("generic_traceback", "Traceback (most recent call last): ..."),
        ("generic_empty", ""),
    ];
    let error_docs = error_cases
        .into_iter()
        .map(|(name, stderr)| {
            let error = MlxError::from_stderr(stderr);
            let doc = json!({
                "name": name,
                "source": { "file": "src-tauri/plugins/tauri-plugin-mlx/src/error.rs", "commit": commit, "provider": "mlx" },
                "comparator": "error-exact",
                "input": { "stderr": stderr },
                "expected": serde_json::to_value(&error).unwrap(),
            });
            (name.to_string(), doc)
        })
        .collect();
    write_set(
        &out,
        "mlx-errors",
        "src-tauri/plugins/tauri-plugin-mlx/src/error.rs",
        &commit,
        "error-exact",
        "expected = serialised MlxError::from_stderr(stderr) {code, message, details?}; details is the raw stderr.",
        error_docs,
    );
    eprintln!("wrote MLX fixtures to {}", out.display());
}
