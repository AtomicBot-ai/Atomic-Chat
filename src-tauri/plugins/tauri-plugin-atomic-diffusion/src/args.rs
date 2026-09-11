//! Pure argv / request builders for `sd-server`. A port of Studio's
//! `sd_cpp_args.py`: no I/O, no process, so every flag decision is unit-tested
//! without a binary or a model file.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::state::{FamilyDefaults, ImageGenerateRequest, OffloadPolicy, ServerSpec};

/// Kill switch for the Metal text-encoder placement (`1`/`true` keeps the
/// encoder on Metal).
pub const METAL_TE_GPU_ENV: &str = "ATOMIC_DIFFUSION_METAL_TE_GPU";

/// Translate the memory policy into sd.cpp offload flags.
///
/// `group`: stream the model (`--offload-to-cpu`) plus flash attention.
/// `model`: also CLIP/VAE on the CPU and VAE tiling. Stable order,
/// de-duplicated.
pub fn offload_flags(policy: OffloadPolicy) -> Vec<String> {
    let mut flags: Vec<&str> = Vec::new();
    match policy {
        OffloadPolicy::None => {}
        OffloadPolicy::Group => {
            flags.push("--offload-to-cpu");
            flags.push("--diffusion-fa");
        }
        OffloadPolicy::Model => {
            flags.push("--offload-to-cpu");
            flags.push("--clip-on-cpu");
            flags.push("--vae-on-cpu");
            flags.push("--diffusion-fa");
            flags.push("--vae-tiling");
        }
    }
    dedup(flags)
}

/// Numerically exact speed-ups (`--diffusion-fa` is a win on its own; direct
/// conv took Z-Image Q8_0 sampling from 56 s to 51 s in Studio's measurements).
pub fn speed_flags() -> Vec<String> {
    vec!["--diffusion-fa".into(), "--diffusion-conv-direct".into()]
}

/// Keep the text encoder on the CPU under Apple Metal.
///
/// ggml's Metal backend `GGML_ABORT`s on `RMS_NORM` for non-contiguous rows
/// with no per-op CPU fallback, so an LLM text encoder (Qwen3 for Z-Image /
/// FLUX.2, T5 for FLUX.1) takes the whole `sd-server` down on the first
/// prompt. The encoder runs once per prompt while the denoiser runs every
/// step, so pinning only the encoder keeps Metal for the part that matters.
pub fn metal_text_encoder_flags(is_macos: bool, env_override: Option<&str>) -> Vec<String> {
    if !is_macos {
        return Vec::new();
    }
    let keep_on_gpu = env_override
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    if keep_on_gpu {
        return Vec::new();
    }
    vec!["--clip-on-cpu".into()]
}

fn metal_text_encoder_flags_for_host() -> Vec<String> {
    let env = std::env::var(METAL_TE_GPU_ENV).ok();
    metal_text_encoder_flags(cfg!(target_os = "macos"), env.as_deref())
}

/// `flags` with every `--backend <spec>` pair removed.
///
/// sd.cpp *concatenates* repeated `--backend` values rather than replacing
/// them, with an explicit per-module entry beating the bare default, so
/// appending `--backend cpu` to a spec that still says `diffusion=CUDA0` leaves
/// the denoiser on CUDA — the CPU-backend restart would be a silent no-op.
pub fn without_device_backend_flags(flags: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(flags.len());
    let mut skip = false;
    for flag in flags {
        if skip {
            skip = false;
            continue;
        }
        if flag == "--backend" {
            skip = true;
            continue;
        }
        out.push(flag.clone());
    }
    out
}

/// The `extra_args` for the one automatic recovery: everything on the CPU
/// backend, with any earlier device pin stripped first.
pub fn cpu_backend_extra_args(extra_args: &[String]) -> Vec<String> {
    let mut out = without_device_backend_flags(extra_args);
    out.push("--backend".into());
    out.push("cpu".into());
    out
}

const GGML_UNSUPPORTED_OP_MARKERS: [&str; 2] = ["unsupported op", "ggml_abort"];

/// True when the captured log tail carries a ggml unsupported-op abort. That
/// signature is deterministic for the graph in question, so a retry on the
/// same backend fails identically while a CPU restart runs it. Any other death
/// must not be retried automatically.
pub fn is_ggml_unsupported_op_abort(text: &str) -> bool {
    let lower = text.to_lowercase();
    GGML_UNSUPPORTED_OP_MARKERS
        .iter()
        .all(|marker| lower.contains(marker))
}

/// Build the `sd-server` argv (without the binary itself).
///
/// Model files first, then the listener, the scratch dirs sd-server insists on
/// iterating, threads, offload, speed and Metal flags (de-duplicated, stable
/// order), `-v` so the per-step sampling lines we parse are printed, and the
/// caller's `extra_args` last: sd.cpp's parser is last-wins.
pub fn build_server_args(spec: &ServerSpec, port: u16, scratch_dir: &Path) -> Vec<String> {
    let files = &spec.files;
    let mut args: Vec<String> = vec!["--diffusion-model".into(), files.diffusion_model.clone()];
    for (flag, value) in [
        ("--vae", &files.vae),
        ("--clip_l", &files.clip_l),
        ("--t5xxl", &files.t5xxl),
        ("--llm", &files.llm),
        ("--qwen2vl", &files.qwen2vl),
    ] {
        if let Some(value) = value {
            if !value.is_empty() {
                args.push(flag.into());
                args.push(value.clone());
            }
        }
    }
    if let Some(format) = files.vae_format.as_deref().filter(|f| !f.is_empty()) {
        args.push("--vae-format".into());
        args.push(format.to_string());
    }
    args.push("--listen-ip".into());
    args.push("127.0.0.1".into());
    args.push("--listen-port".into());
    args.push(port.to_string());

    let scratch = scratch_dir.to_string_lossy().to_string();
    for flag in ["--lora-model-dir", "--hires-upscalers-dir", "--embd-dir"] {
        args.push(flag.into());
        args.push(scratch.clone());
    }
    if let Some(threads) = spec.threads {
        args.push("--threads".into());
        args.push(threads.to_string());
    }

    let mut hardware = offload_flags(spec.offload);
    hardware.extend(speed_flags());
    hardware.extend(metal_text_encoder_flags_for_host());
    args.extend(dedup(hardware.iter().map(String::as_str).collect()));

    args.push("-v".into());
    args.extend(spec.extra_args.iter().cloned());
    args
}

fn dedup(flags: Vec<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(flags.len());
    for flag in flags {
        if !out.iter().any(|f| f == flag) {
            out.push(flag.to_string());
        }
    }
    out
}

/// The `POST /sdcpp/v1/img_gen` body. The whole batch goes in one request;
/// sampling lives under `sample_params` with guidance split the way sd.cpp
/// expects (CFG → `txt_cfg`, FLUX distilled → `distilled_guidance`). Only set
/// keys are emitted so the server's own defaults apply to the rest.
pub fn build_img_gen_request(
    request: &ImageGenerateRequest,
    defaults: &FamilyDefaults,
    seed: i64,
    init_image_b64: Option<&str>,
) -> Value {
    let mut guidance = Map::new();
    guidance.insert("txt_cfg".into(), json!(request.cfg_scale));
    if let Some(distilled) = request.guidance.or(defaults.guidance) {
        guidance.insert("distilled_guidance".into(), json!(distilled));
    }

    let mut sample_params = Map::new();
    sample_params.insert("sample_steps".into(), json!(request.steps));
    if let Some(method) = request
        .sampling_method
        .as_deref()
        .or(defaults.sampling_method.as_deref())
        .filter(|m| !m.is_empty())
    {
        sample_params.insert("sample_method".into(), json!(method));
    }
    if let Some(shift) = request.flow_shift.or(defaults.flow_shift) {
        sample_params.insert("flow_shift".into(), json!(shift));
    }
    sample_params.insert("guidance".into(), Value::Object(guidance));

    let mut body = Map::new();
    body.insert("prompt".into(), json!(request.prompt));
    body.insert(
        "negative_prompt".into(),
        json!(request.negative_prompt.clone().unwrap_or_default()),
    );
    body.insert("width".into(), json!(request.width));
    body.insert("height".into(), json!(request.height));
    body.insert("batch_count".into(), json!(request.batch_size.max(1)));
    body.insert("output_format".into(), json!("png"));
    body.insert("seed".into(), json!(seed));
    body.insert("sample_params".into(), Value::Object(sample_params));
    if let Some(init) = init_image_b64 {
        body.insert("init_image".into(), json!(init));
        body.insert("strength".into(), json!(request.strength.unwrap_or(0.75)));
    }
    Value::Object(body)
}

fn last_option_value<'a>(args: &'a [String], option: &str) -> Option<&'a str> {
    let mut value = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == option {
            if let Some(next) = args.get(i + 1) {
                value = Some(next.as_str());
            }
            i += 2;
            continue;
        }
        let prefix = format!("{option}=");
        if let Some(rest) = args[i].strip_prefix(&prefix) {
            value = Some(rest);
        }
        i += 1;
    }
    value
}

fn compact(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.to_string()
    } else {
        let head: String = value.chars().take(limit.saturating_sub(3)).collect();
        format!("{head}...")
    }
}

/// A one-line summary of the argv for the log: the model's basename and the
/// numeric settings, never a path or prompt text.
pub fn command_summary_for_log(args: &[String]) -> String {
    let mut fields: Vec<String> = Vec::new();
    if let Some(model) = last_option_value(args, "--diffusion-model") {
        let name = model.replace('\\', "/");
        let name = name.rsplit('/').next().unwrap_or("");
        fields.push(format!("model={}", compact(name, 48)));
    }
    if let (Some(w), Some(h)) = (
        last_option_value(args, "--width"),
        last_option_value(args, "--height"),
    ) {
        fields.push(format!("size={}x{}", compact(w, 8), compact(h, 8)));
    }
    for (label, option) in [
        ("steps", "--steps"),
        ("seed", "--seed"),
        ("port", "--listen-port"),
        ("threads", "--threads"),
    ] {
        if let Some(value) = last_option_value(args, option) {
            fields.push(format!("{label}={}", compact(value, 16)));
        }
    }
    if let Some(backend) = last_option_value(args, "--backend") {
        fields.push(format!("backend={}", compact(backend, 32)));
    }
    fields.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        DiffusionBackend, EngineKind, FamilyRanges, ImageWorkflow, Modality, ModelFiles,
    };
    use std::path::PathBuf;
    use std::time::Duration;

    fn spec(files: ModelFiles, offload: OffloadPolicy) -> ServerSpec {
        ServerSpec {
            binary_dir: PathBuf::from("/opt/sd"),
            engine: EngineKind::SdCpp,
            backend: DiffusionBackend::Metal,
            backend_id: "macos-arm64".into(),
            tag: "master-849-d04e895".into(),
            model_id: "z-image:q4_k_m".into(),
            family: "z-image".into(),
            modality: Modality::Image,
            display_name: "Z-Image Turbo".into(),
            files,
            defaults: FamilyDefaults {
                steps: 8,
                cfg_scale: 1.0,
                guidance: None,
                sampling_method: None,
                flow_shift: None,
                width: 1024,
                height: 1024,
            },
            ranges: FamilyRanges {
                steps: (1, 50),
                dims: (256, 2048),
                dim_multiple: 16,
            },
            offload,
            threads: None,
            extra_args: Vec::new(),
            startup_timeout: Duration::from_secs(600),
            cpu_fallback: false,
        }
    }

    fn z_image_files() -> ModelFiles {
        ModelFiles {
            diffusion_model: "/models/z-image/z-image-turbo-Q4_K_M.gguf".into(),
            vae: Some("/models/shared/ae.safetensors".into()),
            llm: Some("/models/shared/Qwen3-4B-Q8_0.gguf".into()),
            ..Default::default()
        }
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    }

    #[test]
    fn every_family_flag_is_emitted_in_supply_order() {
        let files = ModelFiles {
            diffusion_model: "/m/transformer.gguf".into(),
            vae: Some("/m/vae.safetensors".into()),
            vae_format: Some("flux2".into()),
            clip_l: Some("/m/clip_l.safetensors".into()),
            t5xxl: Some("/m/t5xxl.gguf".into()),
            llm: Some("/m/qwen3.gguf".into()),
            qwen2vl: Some("/m/qwen2vl.gguf".into()),
        };
        let args = build_server_args(&spec(files, OffloadPolicy::None), 4242, Path::new("/s"));
        let flags: Vec<&str> = args.iter().map(String::as_str).collect();
        let idx = |flag: &str| flags.iter().position(|f| *f == flag).unwrap();
        assert_eq!(flags[0], "--diffusion-model");
        assert_eq!(flags[1], "/m/transformer.gguf");
        assert!(idx("--vae") < idx("--clip_l"));
        assert!(idx("--clip_l") < idx("--t5xxl"));
        assert!(idx("--t5xxl") < idx("--llm"));
        assert!(idx("--llm") < idx("--qwen2vl"));
        assert_eq!(value_after(&args, "--vae-format"), Some("flux2"));
        assert!(idx("--vae-format") < idx("--listen-ip"));
        assert_eq!(value_after(&args, "--listen-ip"), Some("127.0.0.1"));
        assert_eq!(value_after(&args, "--listen-port"), Some("4242"));
        for flag in ["--lora-model-dir", "--hires-upscalers-dir", "--embd-dir"] {
            assert_eq!(value_after(&args, flag), Some("/s"), "{flag}");
        }
        assert!(flags.contains(&"-v"));
    }

    #[test]
    fn optional_files_and_vae_format_are_omitted_when_absent() {
        let args = build_server_args(
            &spec(z_image_files(), OffloadPolicy::None),
            1,
            Path::new("/s"),
        );
        for flag in [
            "--clip_l",
            "--t5xxl",
            "--qwen2vl",
            "--vae-format",
            "--threads",
        ] {
            assert!(!args.iter().any(|a| a == flag), "{flag} should be absent");
        }
        assert_eq!(
            value_after(&args, "--llm"),
            Some("/models/shared/Qwen3-4B-Q8_0.gguf")
        );
    }

    #[test]
    fn threads_are_passed_when_set() {
        let mut s = spec(z_image_files(), OffloadPolicy::None);
        s.threads = Some(6);
        let args = build_server_args(&s, 1, Path::new("/s"));
        assert_eq!(value_after(&args, "--threads"), Some("6"));
    }

    #[test]
    fn offload_policies_map_to_the_documented_flags() {
        assert!(offload_flags(OffloadPolicy::None).is_empty());
        assert_eq!(
            offload_flags(OffloadPolicy::Group),
            vec!["--offload-to-cpu", "--diffusion-fa"]
        );
        assert_eq!(
            offload_flags(OffloadPolicy::Model),
            vec![
                "--offload-to-cpu",
                "--clip-on-cpu",
                "--vae-on-cpu",
                "--diffusion-fa",
                "--vae-tiling"
            ]
        );
    }

    #[test]
    fn speed_flags_are_deduplicated_against_offload() {
        let args = build_server_args(
            &spec(z_image_files(), OffloadPolicy::Group),
            1,
            Path::new("/s"),
        );
        let fa_count = args.iter().filter(|a| *a == "--diffusion-fa").count();
        assert_eq!(fa_count, 1);
        assert!(args.iter().any(|a| a == "--diffusion-conv-direct"));
        assert!(args.iter().any(|a| a == "--offload-to-cpu"));
    }

    #[test]
    fn clip_on_cpu_appears_once_under_model_offload_on_macos() {
        let args = build_server_args(
            &spec(z_image_files(), OffloadPolicy::Model),
            1,
            Path::new("/s"),
        );
        let count = args.iter().filter(|a| *a == "--clip-on-cpu").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn macos_pins_the_text_encoder_to_the_cpu_unless_overridden() {
        assert_eq!(metal_text_encoder_flags(true, None), vec!["--clip-on-cpu"]);
        assert_eq!(
            metal_text_encoder_flags(true, Some("0")),
            vec!["--clip-on-cpu"]
        );
        assert!(metal_text_encoder_flags(true, Some("1")).is_empty());
        assert!(metal_text_encoder_flags(true, Some(" TRUE ")).is_empty());
        assert!(metal_text_encoder_flags(false, None).is_empty());

        let args = build_server_args(
            &spec(z_image_files(), OffloadPolicy::None),
            1,
            Path::new("/s"),
        );
        let pinned = args.iter().any(|a| a == "--clip-on-cpu");
        assert_eq!(pinned, cfg!(target_os = "macos"));
    }

    #[test]
    fn extra_args_come_last_so_they_win() {
        let mut s = spec(z_image_files(), OffloadPolicy::Group);
        s.extra_args = vec!["--backend".into(), "cpu".into()];
        let args = build_server_args(&s, 1, Path::new("/s"));
        let n = args.len();
        assert_eq!(
            &args[n - 2..],
            &["--backend".to_string(), "cpu".to_string()]
        );
        let v_pos = args.iter().position(|a| a == "-v").unwrap();
        assert!(v_pos < n - 2);
    }

    #[test]
    fn without_device_backend_flags_strips_every_pair() {
        let flags: Vec<String> = [
            "--backend",
            "diffusion=CUDA0,te=cpu",
            "--diffusion-fa",
            "--backend",
            "cpu",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(without_device_backend_flags(&flags), vec!["--diffusion-fa"]);
        assert_eq!(
            cpu_backend_extra_args(&flags),
            vec!["--diffusion-fa", "--backend", "cpu"]
        );
    }

    #[test]
    fn ggml_abort_signature_needs_both_markers() {
        assert!(is_ggml_unsupported_op_abort(
            "ggml_metal_op_encode_impl: error: unsupported op 'RMS_NORM'\nGGML_ABORT ..."
        ));
        assert!(!is_ggml_unsupported_op_abort("unsupported op 'RMS_NORM'"));
        assert!(!is_ggml_unsupported_op_abort("ggml_abort: out of memory"));
        assert!(!is_ggml_unsupported_op_abort(""));
    }

    fn request() -> ImageGenerateRequest {
        ImageGenerateRequest {
            prompt: "a cat".into(),
            negative_prompt: None,
            width: 512,
            height: 768,
            steps: 8,
            cfg_scale: 1.0,
            guidance: None,
            seed: None,
            batch_size: 2,
            sampling_method: None,
            flow_shift: None,
            workflow: Some(ImageWorkflow::Create),
            init_image_path: None,
            strength: None,
        }
    }

    #[test]
    fn img_gen_request_matches_the_sdcpp_schema() {
        let defaults = FamilyDefaults {
            steps: 8,
            cfg_scale: 1.0,
            guidance: Some(3.5),
            sampling_method: Some("euler".into()),
            flow_shift: Some(3.0),
            width: 1024,
            height: 1024,
        };
        let body = build_img_gen_request(&request(), &defaults, 42, None);
        assert_eq!(body["prompt"], "a cat");
        assert_eq!(body["negative_prompt"], "");
        assert_eq!(body["width"], 512);
        assert_eq!(body["height"], 768);
        assert_eq!(body["batch_count"], 2);
        assert_eq!(body["output_format"], "png");
        assert_eq!(body["seed"], 42);
        assert_eq!(body["sample_params"]["sample_steps"], 8);
        assert_eq!(body["sample_params"]["sample_method"], "euler");
        assert_eq!(body["sample_params"]["flow_shift"], 3.0);
        assert_eq!(body["sample_params"]["guidance"]["txt_cfg"], 1.0);
        assert_eq!(body["sample_params"]["guidance"]["distilled_guidance"], 3.5);
        assert!(body.get("init_image").is_none());
    }

    #[test]
    fn request_values_override_family_defaults() {
        let defaults = FamilyDefaults {
            steps: 8,
            cfg_scale: 1.0,
            guidance: Some(3.5),
            sampling_method: Some("euler".into()),
            flow_shift: Some(3.0),
            width: 1024,
            height: 1024,
        };
        let mut req = request();
        req.guidance = Some(2.0);
        req.sampling_method = Some("dpm++2m".into());
        req.flow_shift = Some(1.5);
        req.negative_prompt = Some("blurry".into());
        req.workflow = Some(ImageWorkflow::Transform);
        req.strength = Some(0.6);
        let body = build_img_gen_request(&req, &defaults, 7, Some("AAAA"));
        assert_eq!(body["sample_params"]["guidance"]["distilled_guidance"], 2.0);
        assert_eq!(body["sample_params"]["sample_method"], "dpm++2m");
        assert_eq!(body["sample_params"]["flow_shift"], 1.5);
        assert_eq!(body["negative_prompt"], "blurry");
        assert_eq!(body["init_image"], "AAAA");
        assert_eq!(body["strength"], 0.6);
    }

    #[test]
    fn families_without_guidance_or_flow_shift_omit_them() {
        let defaults = FamilyDefaults {
            steps: 8,
            cfg_scale: 1.0,
            guidance: None,
            sampling_method: None,
            flow_shift: None,
            width: 1024,
            height: 1024,
        };
        let body = build_img_gen_request(&request(), &defaults, 1, None);
        assert!(body["sample_params"]["guidance"]
            .get("distilled_guidance")
            .is_none());
        assert!(body["sample_params"].get("flow_shift").is_none());
        assert!(body["sample_params"].get("sample_method").is_none());
    }

    #[test]
    fn summary_has_the_basename_and_numbers_but_no_path_or_prompt() {
        let mut s = spec(z_image_files(), OffloadPolicy::Group);
        s.threads = Some(4);
        let mut args = build_server_args(&s, 5151, Path::new("/secret/scratch"));
        args.push("--prompt".into());
        args.push("a very private prompt".into());
        let summary = command_summary_for_log(&args);
        assert!(summary.contains("model=z-image-turbo-Q4_K_M.gguf"));
        assert!(summary.contains("port=5151"));
        assert!(summary.contains("threads=4"));
        assert!(!summary.contains("/models/"));
        assert!(!summary.contains("/secret"));
        assert!(!summary.contains("private prompt"));
        assert!(!summary.contains("Qwen3"));
    }

    #[test]
    fn summary_reads_the_last_value_and_equals_form() {
        let args: Vec<String> = [
            "--diffusion-model=/a/first.gguf",
            "--diffusion-model",
            "C:\\models\\second.gguf",
            "--width",
            "512",
            "--height=768",
            "--steps",
            "4",
            "--seed",
            "9",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            command_summary_for_log(&args),
            "model=second.gguf size=512x768 steps=4 seed=9"
        );
    }
}
