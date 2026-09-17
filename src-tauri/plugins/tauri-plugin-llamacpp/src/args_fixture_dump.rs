//! Golden fixtures for `atomic-chat-core`'s llama.cpp argument builder on the TurboQuant provider
//! (`llamacpp`), stage 5. The same cases as the upstream dump where the flag exists here, minus MTP
//! and DFlash (this plugin has neither), plus the rules only this provider has: `turbo*` KV cache
//! types on fork builds, and no Vulkan flash-attention override.
//!
//! ```text
//! cargo test --manifest-path src-tauri/plugins/tauri-plugin-llamacpp/Cargo.toml --lib -- --ignored dump_fixtures
//! ```
//!
//! Writes `<repo>/tests/fixtures/core-contracts/args-llamacpp/<case>.json` and `index.json`.

use super::*;
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn default_config() -> LlamacppConfig {
    LlamacppConfig {
        version_backend: "v1.0/standard".to_string(),
        auto_unload: false,
        timeout: 120,
        llamacpp_env: String::new(),
        fit: false,
        fit_ctx: String::new(),
        fit_target: String::new(),
        chat_template: String::new(),
        n_gpu_layers: 100,
        offload_mmproj: true,
        cpu_moe: false,
        n_cpu_moe: 0,
        override_tensor_buffer_t: String::new(),
        ctx_size: 2048,
        threads: 0,
        threads_batch: 0,
        n_predict: 0,
        batch_size: 0,
        ubatch_size: 0,
        device: String::new(),
        split_mode: "layer".to_string(),
        main_gpu: 0,
        flash_attn: "auto".to_string(),
        cont_batching: false,
        no_mmap: false,
        mlock: false,
        no_kv_offload: false,
        cache_type_k: "f16".to_string(),
        cache_type_v: "f16".to_string(),
        defrag_thold: 0.1,
        rope_scaling: "none".to_string(),
        rope_scale: 1.0,
        rope_freq_base: 0.0,
        rope_freq_scale: 1.0,
        ctx_shift: false,
        parallel: 1,
        concurrent_mode: false,
        concurrent_slots: 8,
        expose_metrics: false,
        reasoning_preserve: false,
        extra_args: String::new(),
    }
}

struct Case {
    name: &'static str,
    is_embedding: bool,
    model_id: &'static str,
    model_path: &'static str,
    port: u16,
    mmproj: Option<&'static str>,
    mutate: fn(&mut LlamacppConfig),
}

fn case(name: &'static str, mutate: fn(&mut LlamacppConfig)) -> Case {
    Case {
        name,
        is_embedding: false,
        model_id: "org/model/q4",
        model_path: "/data/llamacpp/models/org/model/q4/model.gguf",
        port: 3456,
        mmproj: None,
        mutate,
    }
}

fn cases() -> Vec<Case> {
    vec![
        // ── basics ──────────────────────────────────────────────────────
        case("basic_default", |_| {}),
        Case {
            is_embedding: true,
            ..case("embedding_mode", |_| {})
        },
        Case {
            mmproj: Some("/data/llamacpp/models/org/model/q4/mmproj.gguf"),
            ..case("mmproj_offloaded", |_| {})
        },
        Case {
            mmproj: Some("/data/llamacpp/models/org/model/q4/mmproj.gguf"),
            ..case("mmproj_not_offloaded", |c| c.offload_mmproj = false)
        },
        Case {
            mmproj: Some(""),
            ..case("mmproj_empty_string_ignored", |c| c.offload_mmproj = false)
        },
        case("chat_template", |c| c.chat_template = "chatml".into()),
        // ── gpu layers ──────────────────────────────────────────────────
        case("ngl_100_means_all", |c| c.n_gpu_layers = 100),
        case("ngl_32", |c| c.n_gpu_layers = 32),
        case("ngl_negative", |c| c.n_gpu_layers = -5),
        case("ngl_zero_cpu_only", |c| c.n_gpu_layers = 0),
        // ── threads / batch / device ───────────────────────────────────
        case("threads_8_4", |c| {
            c.threads = 8;
            c.threads_batch = 4;
        }),
        case("batch_defaults_omitted", |c| {
            c.batch_size = 2048;
            c.ubatch_size = 512;
        }),
        case("batch_custom", |c| {
            c.batch_size = 1024;
            c.ubatch_size = 256;
        }),
        case("device_split_main_gpu", |c| {
            c.device = "CUDA0,CUDA1".into();
            c.split_mode = "row".into();
            c.main_gpu = 1;
        }),
        case("split_mode_layer_omitted", |c| {
            c.split_mode = "layer".into()
        }),
        case("split_mode_none", |c| c.split_mode = "none".into()),
        // ── flash attention ────────────────────────────────────────────
        case("fa_legacy_v1_auto", |c| c.flash_attn = "auto".into()),
        case("fa_legacy_v1_on", |c| c.flash_attn = "on".into()),
        case("fa_legacy_v1_off", |c| c.flash_attn = "off".into()),
        case("fa_string_b6325_auto", |c| {
            c.version_backend = "b6325/macos-arm64".into();
            c.flash_attn = "auto".into();
        }),
        case("fa_string_b6325_on", |c| {
            c.version_backend = "b6325/macos-arm64".into();
            c.flash_attn = "on".into();
        }),
        case("fa_string_b6325_off", |c| {
            c.version_backend = "b6325/macos-arm64".into();
            c.flash_attn = "off".into();
        }),
        case("fa_legacy_b6324_on", |c| {
            c.version_backend = "b6324/macos-arm64".into();
            c.flash_attn = "on".into();
        }),
        case("fa_turboquant_unified_tag_string_form", |c| {
            c.version_backend = "b10018-1.3.0/macos-arm64".into();
            c.flash_attn = "auto".into();
        }),
        case("fa_turboquant_prefix_string_form", |c| {
            c.version_backend = "turboquant-1.2.0/linux-cuda-12.4-x64".into();
            c.flash_attn = "on".into();
        }),
        case("fa_ik_backend_on", |c| {
            c.version_backend = "b7000/ik-cuda-x64".into();
            c.flash_attn = "on".into();
        }),
        case("fa_ik_backend_auto", |c| {
            c.version_backend = "b7000/ik-cuda-x64".into();
            c.flash_attn = "auto".into();
        }),
        case("fa_vulkan_auto_not_forced_off", |c| {
            c.version_backend = "b10405/win-vulkan-x64".into();
            c.flash_attn = "auto".into();
            c.cache_type_v = "q8_0".into();
        }),
        case("fa_vulkan_explicit_on_kept", |c| {
            c.version_backend = "b10405/win-vulkan-x64".into();
            c.flash_attn = "on".into();
        }),
        // ── boolean toggles / parallel ─────────────────────────────────
        case("toggles_all_on", |c| {
            c.ctx_shift = true;
            c.cont_batching = true;
            c.no_mmap = true;
            c.mlock = true;
            c.no_kv_offload = true;
        }),
        case("parallel_1_adds_kvu", |c| c.parallel = 1),
        case("parallel_4", |c| c.parallel = 4),
        case("parallel_0_omitted", |c| c.parallel = 0),
        case("concurrent_mode_slots_3", |c| {
            c.concurrent_mode = true;
            c.concurrent_slots = 3;
        }),
        case("concurrent_mode_slots_1_floor_2", |c| {
            c.concurrent_mode = true;
            c.concurrent_slots = 1;
        }),
        case("expose_metrics", |c| c.expose_metrics = true),
        // ── reasoning preserve ─────────────────────────────────────────
        case("reasoning_preserve_on_b9837", |c| {
            c.version_backend = "b9837/macos-arm64".into();
            c.reasoning_preserve = true;
        }),
        case("reasoning_preserve_on_b9836_too_old", |c| {
            c.version_backend = "b9836/macos-arm64".into();
            c.reasoning_preserve = true;
        }),
        case("reasoning_preserve_off_b10762_emits_no_flag", |c| {
            c.version_backend = "b10762/macos-arm64".into();
            c.reasoning_preserve = false;
        }),
        case("reasoning_preserve_off_b10761_silent", |c| {
            c.version_backend = "b10761/macos-arm64".into();
            c.reasoning_preserve = false;
        }),
        Case {
            is_embedding: true,
            ..case("reasoning_preserve_ignored_for_embedding", |c| {
                c.version_backend = "b10762/macos-arm64".into();
                c.reasoning_preserve = true;
            })
        },
        // ── text generation block ──────────────────────────────────────
        case("ctx_size_4096_no_fit", |c| c.ctx_size = 4096),
        case("ctx_size_zero_omitted", |c| c.ctx_size = 0),
        case("fit_suppresses_ctx_size", |c| {
            c.ctx_size = 4096;
            c.fit = true;
        }),
        case("n_predict_512", |c| c.n_predict = 512),
        case("cache_k_q8_0", |c| c.cache_type_k = "q8_0".into()),
        case("cache_v_q4_0_with_fa_on", |c| {
            c.version_backend = "b10405/macos-arm64".into();
            c.flash_attn = "on".into();
            c.cache_type_v = "q4_0".into();
        }),
        case("cache_v_dropped_when_fa_off", |c| {
            c.flash_attn = "off".into();
            c.cache_type_v = "q4_0".into();
        }),
        case("cache_v_f32_omitted", |c| {
            c.flash_attn = "on".into();
            c.cache_type_v = "f32".into();
        }),
        // ── turboquant cache types (allowed only on this provider) ───────
        case("cache_turbo3_unified_tag_kept", |c| {
            c.version_backend = "b10018-1.3.0/macos-arm64".into();
            c.flash_attn = "on".into();
            c.cache_type_k = "turbo3".into();
            c.cache_type_v = "turbo3".into();
        }),
        case("cache_turbo4_legacy_prefix_tag_kept", |c| {
            c.version_backend = "turboquant-windows-x64-cuda-12.4-d86eb0b/windows-x64-cuda-12.4".into();
            c.flash_attn = "auto".into();
            c.cache_type_k = "turbo4".into();
            c.cache_type_v = "turbo4".into();
        }),
        case("cache_turbo2_unified_tag_kept", |c| {
            c.version_backend = "b10269-1.4.0/linux-x64-cuda-13.3".into();
            c.cache_type_k = "turbo2".into();
        }),
        case("cache_turbo3_on_plain_upstream_tag_sanitised", |c| {
            c.version_backend = "b8149/linux-x64-vulkan".into();
            c.flash_attn = "on".into();
            c.cache_type_k = "turbo3".into();
            c.cache_type_v = "turbo3".into();
        }),
        case("cache_unknown_type_sanitised", |c| {
            c.version_backend = "b10018-1.3.0/macos-arm64".into();
            c.cache_type_k = "turbo9".into();
        }),
        case("vulkan_linux_auto_keeps_turbo3_v", |c| {
            c.version_backend = "b10018-1.3.0/linux-x64-vulkan".into();
            c.flash_attn = "auto".into();
            c.cache_type_k = "turbo3".into();
            c.cache_type_v = "turbo3".into();
        }),
        case("vulkan_windows_auto_not_forced_off", |c| {
            c.version_backend = "b10018-1.3.0/windows-x64-vulkan".into();
            c.flash_attn = "auto".into();
            c.cache_type_v = "q8_0".into();
        }),
        case("reasoning_preserve_on_unified_tag_b9837_parsed", |c| {
            c.version_backend = "b9837-1.0.0/macos-arm64".into();
            c.reasoning_preserve = true;
        }),
        case("defrag_thold_0_5", |c| c.defrag_thold = 0.5),
        case("rope_all_custom", |c| {
            c.rope_scaling = "linear".into();
            c.rope_scale = 2.0;
            c.rope_freq_base = 10000.0;
            c.rope_freq_scale = 0.5;
        }),
        // ── fit ────────────────────────────────────────────────────────
        case("fit_on_custom_ctx_target", |c| {
            c.fit = true;
            c.fit_ctx = "8192".into();
            c.fit_target = "2048".into();
        }),
        case("fit_on_default_ctx_target_omitted", |c| {
            c.fit = true;
            c.fit_ctx = "4096".into();
            c.fit_target = "1024".into();
        }),
        case("fit_skipped_on_ik_backend", |c| {
            c.version_backend = "b7000/ik-cuda-x64".into();
            c.fit = true;
            c.fit_ctx = "8192".into();
        }),
        // ── moe / tensor override ──────────────────────────────────────
        case("cpu_moe_and_n_cpu_moe", |c| {
            c.cpu_moe = true;
            c.n_cpu_moe = 4;
            c.override_tensor_buffer_t = "blk\\.[0-9]+\\.ffn.*=CPU".into();
        }),
        // ── extra args ─────────────────────────────────────────────────
        case("extra_args_quoting", |c| {
            c.extra_args =
                r#"--foo bar "quoted arg" 'single q' esc\ aped --ctx-size 999"#.into()
        }),
        case("extra_args_unterminated_quote_dropped", |c| {
            c.extra_args = r#"--foo "unterminated"#.into()
        }),
        case("extra_args_empty_quotes_give_empty_arg", |c| {
            c.extra_args = r#"--stop """#.into()
        }),
        // ── version parsing ────────────────────────────────────────────
        case("version_backend_with_bom", |c| {
            c.version_backend = "\u{FEFF}b6325/macos-arm64".into()
        }),
        case("version_backend_without_slash_is_error", |c| {
            c.version_backend = "b1234".into()
        }),
        case("version_backend_padded_parts", |c| {
            c.version_backend = " b6325 / macos-arm64 ".into()
        }),
    ]
}

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

#[test]
#[ignore]
fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/args-llamacpp");
    fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);
    let source = "src-tauri/plugins/tauri-plugin-llamacpp/src/args.rs";

    let mut names = Vec::new();
    for c in cases() {
        let mut config = default_config();
        (c.mutate)(&mut config);
        let input = json!({
            "config": config,
            "is_embedding": c.is_embedding,
            "model_id": c.model_id,
            "model_path": c.model_path,
            "port": c.port,
            "mmproj_path": c.mmproj,
        });
        let result = match ArgumentBuilder::new(config.clone(), c.is_embedding) {
            Ok(builder) => {
                json!({ "argv": builder.build(c.model_id, c.model_path, c.port, c.mmproj.map(String::from)) })
            }
            Err(e) => json!({ "error": e }),
        };
        let doc = json!({
            "name": c.name,
            "source": { "file": source, "commit": commit, "provider": "llamacpp" },
            "comparator": "argv-exact",
            "input": input,
            "expected": result,
        });
        fs::write(
            out.join(format!("{}.json", c.name)),
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
        names.push(c.name);
    }
    let index = json!({
        "source": { "file": source, "commit": commit },
        "comparator": "argv-exact",
        "note": "Same comparison rules as the upstream args set (ordered argv, f32 floats). The TurboQuant config has no mtp/dflash fields: the port must treat them as false for provider llamacpp.",
        "cases": names,
    });
    fs::write(
        out.join("index.json"),
        serde_json::to_string_pretty(&index).unwrap() + "\n",
    )
    .unwrap();
    eprintln!("wrote {} args fixtures to {}", names.len(), out.display());
}
