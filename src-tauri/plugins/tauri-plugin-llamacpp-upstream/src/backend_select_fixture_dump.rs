//! Golden fixtures for the hardware-gated backend decisions of the upstream provider
//! (atomic-chat-core stage 10c). The eight decision commands of this plugin are now answered by
//! the core (`src/backend/select/{features,categories}.ts`, `src/backend/catalog/migrate.ts`);
//! the `#[test]` tables in `backend.rs` stay the truth, and this module writes them out as JSON
//! for the core's `test/contract/backend-select.test.ts` to replay.
//!
//! Every input is a JSON document deserialised into the command's own argument types, so a case
//! holds exactly what the command would receive over the wire, and every output is the command's
//! own serialisation. Nothing here reads hardware, disk or network: `get_supported_features` on
//! this provider is pure (the Windows ROCm gate is a PCI table).
//!
//! A child module so the private `rocm_supported_windows` table lookups can be driven as they are.
//!
//! Run (from `src-tauri/`):
//! `cargo test --manifest-path plugins/tauri-plugin-llamacpp-upstream/Cargo.toml --lib -- --ignored backend::backend_select_fixture_dump::dump_fixtures`
//! then `node scripts/import-app-fixtures.mjs` in the core repository.

use serde_json::{json, Value};

use super::*;

const SOURCE: &str = "src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs";
const PROVIDER: &str = "llamacpp-upstream";
const SET: &str = "backend-select";
const PROFILES: &str = "tests/fixtures/hardware/profiles.json";

fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

fn git_head(root: &std::path::Path) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

// ---------------------------------------------------------------------------------------------
// Input builders
// ---------------------------------------------------------------------------------------------

fn nvidia(driver: &str, compute_capability: &str) -> Value {
    json!({
        "vendor": "NVIDIA",
        "driver_version": driver,
        "nvidia_info": {"compute_capability": compute_capability},
        "vulkan_info": null,
    })
}

fn vulkan_gpu(vendor: Option<&str>, device_id: Option<u32>) -> Value {
    json!({
        "vendor": vendor,
        "driver_version": "0.0",
        "nvidia_info": null,
        "vulkan_info": {"api_version": "1.3", "device_id": device_id},
    })
}

fn amd(device_id: Option<u32>) -> Value {
    vulkan_gpu(Some("AMD"), device_id)
}

fn vb(version: &str, backend: &str, order: u32) -> Value {
    json!({"version": version, "backend": backend, "order": order})
}

fn features_input(os_type: &str, cpu_extensions: &[&str], gpus: Vec<Value>) -> Value {
    json!({"kind": "features", "os_type": os_type, "cpu_extensions": cpu_extensions, "gpus": gpus})
}

fn supported_input(os_type: &str, arch: &str, flags: [bool; 5]) -> Value {
    let [cuda11, cuda12, cuda13, vulkan, rocm] = flags;
    json!({
        "kind": "supported",
        "os_type": os_type,
        "arch": arch,
        "features": {"cuda11": cuda11, "cuda12": cuda12, "cuda13": cuda13, "vulkan": vulkan, "rocm": rocm},
    })
}

fn with_opencl(mut input: Value) -> Value {
    input["features"]["opencl"] = json!(true);
    input
}

fn prioritize_input(version_backends: Vec<Value>, has_enough_gpu_memory: bool) -> Value {
    json!({"kind": "prioritize", "version_backends": version_backends, "has_enough_gpu_memory": has_enough_gpu_memory})
}

fn merge_input(remote: Vec<Value>, local: Vec<Value>) -> Value {
    json!({"kind": "merge", "remote": remote, "local": local})
}

fn latest_input(version_backends: Vec<Value>, backend_type: &str) -> Value {
    json!({"kind": "latest", "version_backends": version_backends, "backend_type": backend_type})
}

fn update_check_input(current: &str, version_backends: Vec<Value>) -> Value {
    json!({"kind": "update_check", "current": current, "version_backends": version_backends})
}

fn migrate_input(stored_type: &str, version_backends: Vec<Value>) -> Value {
    json!({"kind": "migrate", "stored_type": stored_type, "version_backends": version_backends})
}

fn setting_update_input(key: &str, value: &str, stored_type: Option<&str>) -> Value {
    json!({"kind": "setting_update", "key": key, "value": value, "stored_type": stored_type})
}

fn case_name(kind: &str, id: &str) -> String {
    let slug: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    format!("{kind}_{slug}")
}

// ---------------------------------------------------------------------------------------------
// Running a case through the commands
// ---------------------------------------------------------------------------------------------

fn from<T: serde::de::DeserializeOwned>(input: &Value, key: &str) -> T {
    serde_json::from_value(input[key].clone())
        .unwrap_or_else(|e| panic!("input.{key} does not deserialise into the command's type: {e}"))
}

fn ok_or_error<T: serde::Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(value) => serde_json::to_value(value).unwrap(),
        Err(error) => json!({"error": error}),
    }
}

async fn run(input: &Value) -> Value {
    match input["kind"].as_str().unwrap() {
        "features" => ok_or_error(get_supported_features(
            from(input, "os_type"),
            from(input, "cpu_extensions"),
            from::<Vec<GpuInfo>>(input, "gpus"),
        )),
        "supported" => ok_or_error(determine_supported_backends(
            from(input, "os_type"),
            from(input, "arch"),
            from::<SystemFeatures>(input, "features"),
        )),
        "prioritize" => ok_or_error(
            prioritize_backends(
                from::<Vec<BackendInfo>>(input, "version_backends"),
                from(input, "has_enough_gpu_memory"),
            )
            .await,
        ),
        "merge" => ok_or_error(
            list_supported_backends(
                from::<Vec<BackendInfo>>(input, "remote"),
                from::<Vec<BackendInfo>>(input, "local"),
            )
            .await,
        ),
        "latest" => serde_json::to_value(find_latest_version_for_backend(
            from::<Vec<BackendInfo>>(input, "version_backends"),
            from(input, "backend_type"),
        ))
        .unwrap(),
        "update_check" => ok_or_error(
            check_backend_for_updates(
                from(input, "current"),
                from::<Vec<BackendInfo>>(input, "version_backends"),
            )
            .await,
        ),
        "migrate" => ok_or_error(should_migrate_backend(
            from(input, "stored_type"),
            from::<Vec<BackendInfo>>(input, "version_backends"),
        )),
        "setting_update" => ok_or_error(handle_setting_update(
            from(input, "key"),
            from(input, "value"),
            from::<Option<String>>(input, "stored_type"),
        )),
        other => panic!("unknown case kind {other}"),
    }
}

// ---------------------------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------------------------

fn feature_cases(root: &std::path::Path) -> Vec<(String, Value)> {
    let table = crate::amd_rocm_pci_ids::AMD_ROCM_WINDOWS_PCI_IDS;
    let first_id = table[0].0;
    let last_id = table[table.len() - 1].0;
    const NAVI31: u32 = 0x744c;
    const VEGA10: u32 = 0x687f;

    let mut cases: Vec<(String, Value)> = vec![
        ("cpu_only_linux_avx_avx2", features_input("linux", &["avx", "avx2"], vec![])),
        ("cpu_only_windows_avx512", features_input("windows", &["avx512"], vec![])),
        ("linux_nvidia_530_cuda11_cuda12_not_cuda13", features_input("linux", &[], vec![nvidia("530.00", "8.0")])),
        ("linux_nvidia_580_exact_cuda13_floor", features_input("linux", &[], vec![nvidia("580", "8.9")])),
        ("linux_nvidia_580_65_cuda13", features_input("linux", &[], vec![nvidia("580.65", "8.9")])),
        ("linux_nvidia_579_99_no_cuda13", features_input("linux", &[], vec![nvidia("579.99", "8.9")])),
        ("windows_vulkan_only_unknown_vendor", features_input("windows", &[], vec![vulkan_gpu(None, None)])),
        ("windows_driver_550_no_cuda_tier", features_input("windows", &[], vec![nvidia("550.00", "8.9")])),
        ("windows_driver_551_60_no_cuda_tier", features_input("windows", &[], vec![nvidia("551.60", "8.9")])),
        ("windows_driver_551_61_cuda12_only", features_input("windows", &[], vec![nvidia("551.61", "8.9")])),
        ("windows_driver_581_14_cuda12_only", features_input("windows", &[], vec![nvidia("581.14", "8.9")])),
        ("windows_driver_581_15_cuda12_and_cuda13", features_input("windows", &[], vec![nvidia("581.15", "8.9")])),
        ("windows_driver_581_42_cuda12_and_cuda13", features_input("windows", &[], vec![nvidia("581.42", "8.9")])),
        ("windows_volta_7_0_vetoes_cuda13", features_input("windows", &[], vec![nvidia("581.42", "7.0")])),
        ("windows_pascal_6_1_vetoes_cuda13", features_input("windows", &[], vec![nvidia("581.42", "6.1")])),
        ("windows_maxwell_5_2_vetoes_cuda13", features_input("windows", &[], vec![nvidia("581.42", "5.2")])),
        ("windows_turing_7_5_is_the_cuda13_floor", features_input("windows", &[], vec![nvidia("581.42", "7.5")])),
        ("windows_blackwell_10_0_gets_cuda13", features_input("windows", &[], vec![nvidia("581.42", "10.0")])),
        ("windows_blackwell_12_0_gets_cuda13", features_input("windows", &[], vec![nvidia("581.42", "12.0")])),
        ("windows_major_only_compute_capability_8", features_input("windows", &[], vec![nvidia("581.42", "8")])),
        ("windows_padded_compute_capability_12_0", features_input("windows", &[], vec![nvidia("581.42", " 12.0 ")])),
        (
            "windows_one_old_gpu_vetoes_cuda13_for_the_host",
            features_input("windows", &[], vec![nvidia("581.42", "8.9"), nvidia("581.42", "7.0")]),
        ),
        ("windows_unknown_compute_capability_keeps_cuda13", features_input("windows", &[], vec![nvidia("581.42", "")])),
        ("windows_unreadable_compute_capability_keeps_cuda13", features_input("windows", &[], vec![nvidia("581.42", "unknown")])),
        (
            "windows_nvidia_info_without_compute_capability",
            features_input(
                "windows",
                &[],
                vec![json!({"driver_version": "581.42", "nvidia_info": {"index": 0}, "vulkan_info": null})],
            ),
        ),
        (
            "windows_nvidia_with_vulkan_enables_both",
            features_input(
                "windows",
                &[],
                vec![json!({
                    "vendor": "NVIDIA",
                    "driver_version": "581.42",
                    "nvidia_info": {"compute_capability": "8.9"},
                    "vulkan_info": {"api_version": "1.3", "device_id": 9860},
                })],
            ),
        ),
        ("windows_amd_navi31_0x744c_enables_rocm", features_input("windows", &[], vec![amd(Some(NAVI31))])),
        ("windows_amd_table_first_entry_enables_rocm", features_input("windows", &[], vec![amd(Some(first_id))])),
        ("windows_amd_table_last_entry_enables_rocm", features_input("windows", &[], vec![amd(Some(last_id))])),
        ("windows_amd_lowercase_vendor_enables_rocm", features_input("windows", &[], vec![vulkan_gpu(Some("amd"), Some(NAVI31))])),
        ("windows_non_amd_vendor_with_table_id_no_rocm", features_input("windows", &[], vec![vulkan_gpu(Some("Intel"), Some(NAVI31))])),
        ("windows_amd_vega_0x687f_no_rocm", features_input("windows", &[], vec![amd(Some(VEGA10))])),
        ("windows_amd_without_device_id_no_rocm", features_input("windows", &[], vec![amd(None)])),
        ("windows_amd_any_of_several_gpus_enables_rocm", features_input("windows", &[], vec![amd(Some(VEGA10)), amd(Some(NAVI31))])),
        ("linux_amd_navi31_no_rocm_upstream", features_input("linux", &[], vec![amd(Some(NAVI31))])),
        (
            "macos_ignores_every_gpu",
            features_input("macos", &["avx"], vec![nvidia("581.42", "8.9"), amd(Some(NAVI31))]),
        ),
        ("unknown_os_only_cpu_flags", features_input("freebsd", &["avx2"], vec![nvidia("581.42", "8.9")])),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("features", id), input))
    .collect();

    // The six machine profiles the app's own deterministic tests use. Their `features` block is
    // that TypeScript test's assumption; here the plugin computes the features itself. The
    // profiles carry no `vulkan_info.api_version`, which this plugin's `VulkanInfo` requires, so
    // `1.3` is added before the GPUs are handed to the command.
    let profiles: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(root.join(PROFILES)).unwrap()).unwrap();
    for profile in profiles {
        let system_info = &profile["system_info"];
        let os_type = system_info["os_type"].as_str().unwrap();
        let cpu_extensions: Vec<&str> = system_info["cpu"]["extensions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e.as_str().unwrap())
            .collect();
        let gpus: Vec<Value> = system_info["gpus"]
            .as_array()
            .unwrap()
            .iter()
            .map(|gpu| {
                let mut gpu = gpu.clone();
                if let Some(vulkan) = gpu.get_mut("vulkan_info").and_then(|v| v.as_object_mut()) {
                    vulkan.entry("api_version").or_insert(json!("1.3"));
                }
                gpu
            })
            .collect();
        cases.push((
            case_name("features", &format!("profile_{}", profile["name"].as_str().unwrap())),
            features_input(os_type, &cpu_extensions, gpus),
        ));
    }
    cases
}

fn supported_cases() -> Vec<(String, Value)> {
    // [cuda11, cuda12, cuda13, vulkan, rocm]
    const NONE: [bool; 5] = [false, false, false, false, false];
    const ALL: [bool; 5] = [true, true, true, true, true];
    vec![
        ("windows_x86_64_cuda12_vulkan_cuda11_ignored", supported_input("windows", "x86_64", [true, true, false, true, false])),
        ("windows_x86_64_cuda13_family_id", supported_input("windows", "x86_64", [false, true, true, false, false])),
        ("windows_x86_64_rocm_family_id_keeps_vulkan", supported_input("windows", "x86_64", [false, false, false, true, true])),
        ("windows_x86_64_every_flag", supported_input("windows", "x86_64", ALL)),
        ("windows_x86_64_no_flags", supported_input("windows", "x86_64", NONE)),
        ("windows_aarch64_every_flag_but_opencl", supported_input("windows", "aarch64", ALL)),
        ("windows_aarch64_opencl_adreno", with_opencl(supported_input("windows", "aarch64", NONE))),
        ("windows_aarch64_every_flag", with_opencl(supported_input("windows", "aarch64", ALL))),
        ("windows_arm64_cpu_only", supported_input("windows", "arm64", NONE)),
        ("windows_x86_64_opencl_ignored", with_opencl(supported_input("windows", "x86_64", NONE))),
        ("linux_x86_64_cpu_only", supported_input("linux", "x86_64", NONE)),
        ("linux_x86_64_with_vulkan", supported_input("linux", "x86_64", [false, false, false, true, false])),
        ("linux_x86_64_cuda_flags_ignored", supported_input("linux", "x86_64", [true, true, true, false, false])),
        ("linux_x86_64_nvidia_with_vulkan", supported_input("linux", "x86_64", [true, true, false, true, false])),
        ("linux_x86_64_rocm_flag_ignored", supported_input("linux", "x86_64", [false, false, false, true, true])),
        ("linux_x86_alias_with_vulkan", supported_input("linux", "x86", [false, false, false, true, false])),
        ("linux_aarch64_every_flag", supported_input("linux", "aarch64", ALL)),
        ("linux_aarch64_with_vulkan", supported_input("linux", "aarch64", [false, false, false, true, false])),
        ("linux_aarch64_cuda13_family_id", supported_input("linux", "aarch64", [false, true, true, false, false])),
        ("linux_arm64_opencl_ignored", with_opencl(supported_input("linux", "arm64", NONE))),
        ("linux_arm64_cpu_only", supported_input("linux", "arm64", NONE)),
        ("macos_x86_64", supported_input("macos", "x86_64", NONE)),
        ("macos_x86_alias", supported_input("macos", "x86", ALL)),
        ("macos_aarch64", supported_input("macos", "aarch64", NONE)),
        ("macos_arm64", supported_input("macos", "arm64", ALL)),
        ("unsupported_freebsd_x86_64", supported_input("freebsd", "x86_64", ALL)),
        ("unsupported_windows_x86_32_bit", supported_input("windows", "x86", ALL)),
        ("unsupported_linux_riscv64", supported_input("linux", "riscv64", NONE)),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("supported", id), input))
    .collect()
}

fn prioritize_cases() -> Vec<(String, Value)> {
    let cuda13_catalog = || {
        vec![
            vb("b9900", "win-cuda-13.1-x64", 10),
            vb("b10205", "win-cuda-13.3-x64", 1),
            vb("b10205", "win-cuda-12.4-x64", 1),
            vb("b10205", "win-vulkan-x64", 1),
        ]
    };
    let linux = || vec![vb("b10205", "linux-cpu-x64", 1), vb("b10205", "linux-vulkan-x64", 1)];
    let rocm = || {
        vec![
            vb("b10405", "win-vulkan-x64", 1),
            vb("b10405", "win-rocm-7.14-x64", 1),
            vb("b10405", "win-cpu-x64", 1),
        ]
    };
    vec![
        ("prefers_newest_cuda13_asset", prioritize_input(cuda13_catalog(), true)),
        ("cuda13_leads_without_enough_vram_too", prioritize_input(cuda13_catalog(), false)),
        ("linux_vulkan_with_enough_gpu_memory", prioritize_input(linux(), true)),
        ("linux_cpu_without_enough_gpu_memory", prioritize_input(linux(), false)),
        ("rocm_over_vulkan_with_enough_gpu_memory", prioritize_input(rocm(), true)),
        ("cpu_over_gpu_tiers_without_enough_gpu_memory", prioritize_input(rocm(), false)),
        ("empty_catalog_rejected", prioritize_input(vec![], true)),
        (
            "cuda12_beats_cpu_even_without_enough_gpu_memory",
            prioritize_input(vec![vb("b10205", "win-cpu-x64", 1), vb("b10205", "win-cuda-12.4-x64", 1)], false),
        ),
        (
            "newest_within_category_numeric_tags",
            prioritize_input(vec![vb("b9999", "win-cuda-12.4-x64", 0), vb("b10344", "win-cuda-12.4-x64", 0)], true),
        ),
        (
            "cuda13_family_id_categorises_as_x64",
            prioritize_input(vec![vb("b10205", "win-cuda-13-x64", 0), vb("b10205", "win-vulkan-x64", 0)], true),
        ),
        (
            "legacy_cu13_0_outranks_cuda_12_4",
            prioritize_input(vec![vb("b7523", "win-cuda-12.4-x64", 0), vb("b7523", "win-noavx-cuda-cu13.0-x64", 0)], true),
        ),
        (
            "legacy_avx2_outranks_noavx_read_as_avx",
            prioritize_input(vec![vb("b7523", "win-noavx-x64", 0), vb("b7523", "win-avx2-x64", 0)], true),
        ),
        ("macos_arm64_category", prioritize_input(vec![vb("b10205", "macos-arm64", 0)], false)),
        (
            "windows_arm64_cuda13_over_opencl_over_cpu",
            prioritize_input(
                vec![
                    vb("b11344", "win-cpu-arm64", 0),
                    vb("b11344", "win-opencl-adreno-arm64", 0),
                    vb("b11344", "win-cuda-13.4-arm64", 0),
                ],
                true,
            ),
        ),
        (
            "windows_arm64_opencl_over_cpu_without_enough_gpu_memory",
            prioritize_input(vec![vb("b11344", "win-cpu-arm64", 0), vb("b11344", "win-opencl-adreno-arm64", 0)], false),
        ),
        (
            "linux_arm64_cuda13_over_vulkan_over_cpu",
            prioritize_input(
                vec![
                    vb("b11344", "linux-cpu-arm64", 0),
                    vb("b11344", "linux-vulkan-arm64", 0),
                    vb("b11344", "linux-cuda-13.4-arm64", 0),
                ],
                true,
            ),
        ),
        (
            "linux_arm64_cpu_without_enough_gpu_memory",
            prioritize_input(vec![vb("b11344", "linux-cpu-arm64", 0), vb("b11344", "linux-vulkan-arm64", 0)], false),
        ),
        (
            "no_category_falls_back_to_first_entry",
            prioritize_input(vec![vb("b7523", "backend-a", 0), vb("b7524", "backend-b", 0)], true),
        ),
        (
            "installed_cuda13_1_next_to_remote_13_3_picks_newest",
            prioritize_input(vec![vb("b9900", "win-cuda-13.1-x64", 1_800_000_000), vb("b10205", "win-cuda-13.3-x64", 0)], true),
        ),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("prioritize", id), input))
    .collect()
}

fn merge_cases() -> Vec<(String, Value)> {
    vec![
        (
            "sorting_and_dedup",
            merge_input(
                vec![vb("b7523", "backend-a", 1), vb("b7523", "backend-b", 1)],
                vec![vb("b7523", "backend-a", 0), vb("b7524", "backend-c", 2)],
            ),
        ),
        (
            "local_higher_order_replaces_remote",
            merge_input(vec![vb("b7523", "macos-arm64", 0)], vec![vb("b7523", "macos-arm64", 5)]),
        ),
        (
            "numeric_tag_order_b9999_below_b10344",
            merge_input(vec![vb("b9999", "linux-vulkan-x64", 0), vb("b10344", "linux-vulkan-x64", 0)], vec![]),
        ),
        (
            "tagged_build_before_untagged",
            merge_input(vec![vb("b10205", "macos-arm64", 0)], vec![vb("custom-build", "macos-arm64", 9)]),
        ),
        (
            "untagged_windows_by_parsed_build_number",
            merge_input(vec![], vec![vb("v7524", "win-cuda-12.4-x64", 9), vb("v7525", "win-cuda-12.4-x64", 0)]),
        ),
        (
            "ties_fall_to_order_then_version_then_backend",
            merge_input(
                vec![
                    vb("custom-a", "macos-x64", 1),
                    vb("custom-b", "macos-arm64", 1),
                    vb("custom-a", "macos-arm64", 1),
                    vb("custom-c", "macos-arm64", 0),
                ],
                vec![],
            ),
        ),
        (
            "remote_without_order_defaults_to_zero",
            merge_input(
                vec![json!({"version": "b10344", "backend": "macos-arm64"})],
                vec![vb("b10205", "macos-arm64", 1_800_000_000)],
            ),
        ),
        ("empty_inputs", merge_input(vec![], vec![])),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("merge", id), input))
    .collect()
}

fn latest_cases() -> Vec<(String, Value)> {
    vec![
        (
            "linux_cpu_by_tag",
            latest_input(
                vec![vb("b7523", "linux-cpu-x64", 2), vb("b7524", "linux-cpu-x64", 3), vb("b7522", "linux-cpu-x64", 1)],
                "linux-cpu-x64",
            ),
        ),
        (
            "prefers_newer_tag_over_install_time",
            latest_input(vec![vb("b10205", "macos-arm64", 1_800_000_000), vb("b10344", "macos-arm64", 0)], "macos-arm64"),
        ),
        (
            "orders_tags_numerically_not_lexically",
            latest_input(vec![vb("b9999", "linux-vulkan-x64", 0), vb("b10344", "linux-vulkan-x64", 0)], "linux-vulkan-x64"),
        ),
        (
            "falls_back_to_order_for_non_release_tags",
            latest_input(vec![vb("custom-build", "macos-arm64", 1), vb("another-build", "macos-arm64", 2)], "macos-arm64"),
        ),
        (
            "windows_uses_version_not_order",
            latest_input(vec![vb("b7524", "win-cuda-12.4-x64", 1_800_000_000), vb("b7525", "win-cuda-12.4-x64", 0)], "win-cuda-12.4-x64"),
        ),
        (
            "legacy_id_matches_after_migration",
            latest_input(vec![vb("b7523", "linux-avx2-x64", 1), vb("b7524", "linux-cpu-x64", 2)], "linux-cpu-x64"),
        ),
        (
            "keeps_legacy_spelling_when_it_wins",
            latest_input(vec![vb("b7525", "linux-avx2-x64", 0), vb("b7524", "linux-cpu-x64", 0)], "linux-cpu-x64"),
        ),
        ("none_when_type_absent", latest_input(vec![vb("b7524", "linux-cpu-x64", 0)], "linux-vulkan-x64")),
        ("none_for_empty_catalog", latest_input(vec![], "macos-arm64")),
        (
            "family_id_query_does_not_match_concrete_cuda13",
            latest_input(vec![vb("b10205", "win-cuda-13.3-x64", 0)], "win-cuda-13-x64"),
        ),
        (
            "cuda13_1_migrates_onto_13_3_query",
            latest_input(vec![vb("b9900", "win-cuda-13.1-x64", 0)], "win-cuda-13.3-x64"),
        ),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("latest", id), input))
    .collect()
}

fn update_check_cases() -> Vec<(String, Value)> {
    let legacy_turboquant = || {
        vec![
            vb("turboquant-macos-arm64-e3dad20", "macos-arm64", 1),
            vb("turboquant-macos-arm64-18a8ef1", "macos-arm64", 2),
        ]
    };
    vec![
        (
            "offers_newer_macos_tag",
            update_check_input(
                "b10205/macos-arm64",
                vec![vb("b10205", "macos-arm64", 1_800_000_000), vb("b10344", "macos-arm64", 0)],
            ),
        ),
        ("legacy_tags_by_order_needs_update", update_check_input("turboquant-macos-arm64-e3dad20/macos-arm64", legacy_turboquant())),
        ("legacy_tags_by_order_already_latest", update_check_input("turboquant-macos-arm64-18a8ef1/macos-arm64", legacy_turboquant())),
        (
            "windows_uses_version_not_order",
            update_check_input(
                "b7524/win-cuda-12.4-x64",
                vec![vb("b7524", "win-cuda-12.4-x64", 1_800_000_000), vb("b7525", "win-cuda-12.4-x64", 0)],
            ),
        ),
        ("no_versions_for_type", update_check_input("b10205/macos-arm64", vec![vb("b10344", "macos-x64", 0)])),
        ("empty_catalog", update_check_input("b10205/macos-arm64", vec![])),
        ("invalid_format_no_slash", update_check_input("b10205", vec![vb("b10205", "macos-arm64", 0)])),
        ("invalid_format_two_slashes", update_check_input("b10205/macos-arm64/extra", vec![])),
        (
            "legacy_current_migrates_type",
            update_check_input("b7523/linux-avx2-x64", vec![vb("b7524", "linux-cpu-x64", 0)]),
        ),
        (
            "catalog_older_than_current_still_differs",
            update_check_input("b10344/macos-arm64", vec![vb("b10205", "macos-arm64", 0)]),
        ),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("update_check", id), input))
    .collect()
}

fn migrate_cases() -> Vec<(String, Value)> {
    vec![
        ("linux_avx2_to_cpu_when_available", migrate_input("linux-avx2-x64", vec![vb("b7524", "linux-cpu-x64", 1)])),
        ("clean_id_needs_no_migration", migrate_input("linux-cpu-x64", vec![vb("b7524", "linux-cpu-x64", 1)])),
        ("skipped_when_target_not_available", migrate_input("linux-avx2-x64", vec![vb("b7524", "linux-vulkan-x64", 1)])),
        (
            "target_available_under_legacy_spelling",
            migrate_input("win-cuda-12-common_cpus-x64", vec![vb("b7524", "win-noavx-cuda-cu12.0-x64", 1)]),
        ),
        ("win_cuda_13_1_to_13_3", migrate_input("win-cuda-13.1-x64", vec![vb("b10205", "win-cuda-13.3-x64", 0)])),
        ("ubuntu_vulkan_to_linux_vulkan", migrate_input("ubuntu-vulkan-x64", vec![vb("b10205", "linux-vulkan-x64", 0)])),
        ("family_id_needs_no_migration", migrate_input("win-cuda-13-x64", vec![vb("b10205", "win-cuda-13.3-x64", 0)])),
        (
            "win_cuda_13_4_arm64_kept",
            migrate_input("win-cuda-13.4-arm64", vec![vb("b11344", "win-cuda-13.3-arm64", 0)]),
        ),
        (
            "win_opencl_adreno_arm64_kept",
            migrate_input("win-opencl-adreno-arm64", vec![vb("b11344", "win-cpu-arm64", 0)]),
        ),
        (
            "linux_cuda_13_4_arm64_kept",
            migrate_input("linux-cuda-13.4-arm64", vec![vb("b11344", "linux-cpu-arm64", 0)]),
        ),
        (
            "ubuntu_cuda_arm64_to_linux_cuda",
            migrate_input("ubuntu-cuda-13.4-arm64", vec![vb("b11344", "linux-cuda-13.4-arm64", 0)]),
        ),
        ("empty_catalog_skips", migrate_input("linux-avx2-x64", vec![])),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("migrate", id), input))
    .collect()
}

fn setting_update_cases() -> Vec<(String, Value)> {
    let mut cases: Vec<(String, Value)> = vec![
        ("other_key_is_a_noop", setting_update_input("ctx_size", "4096", Some("win-cpu-x64"))),
        ("new_type_with_nothing_stored", setting_update_input("version_backend", "b10205/win-cuda-12.4-x64", None)),
        ("same_stored_type_not_updated", setting_update_input("version_backend", "b10205/win-cuda-12.4-x64", Some("win-cuda-12.4-x64"))),
        ("different_stored_type_updated", setting_update_input("version_backend", "b10205/win-cuda-12.4-x64", Some("win-cpu-x64"))),
        ("legacy_value_compared_after_migration", setting_update_input("version_backend", "b7523/win-cuda-12-common_cpus-x64", Some("win-cuda-12.4-x64"))),
        ("bom_stripped", setting_update_input("version_backend", "\u{FEFF}b10205/win-cpu-x64", None)),
        ("parts_trimmed", setting_update_input("version_backend", " b10205 / win-cpu-x64 ", None)),
        ("invalid_no_slash", setting_update_input("version_backend", "b10205", None)),
        ("invalid_two_slashes", setting_update_input("version_backend", "a/b/c", None)),
        ("invalid_empty_version", setting_update_input("version_backend", "/win-cpu-x64", None)),
        ("invalid_empty_backend_reports_raw_value", setting_update_input("version_backend", "\u{FEFF}b1/", None)),
        ("invalid_empty_string", setting_update_input("version_backend", "", None)),
    ]
    .into_iter()
    .map(|(id, input)| (case_name("setting_update", id), input))
    .collect();

    // `map_old_backend_to_new`, pinned through the setting update's `effective_backend_type`.
    // Every id the plugin's own tests assert, plus the family and ubuntu spellings.
    for id in [
        "linux-avx2-cuda-cu12.0-x64",
        "linux-cuda-12-common_cpus-x64",
        "linux-cuda-13-common_cpus-x64",
        "win-noavx-cuda-cu11.7-x64",
        "win-cuda-12-common_cpus-x64",
        "win-cuda-13-common_cpus-x64",
        "win-cuda-12.4-x64",
        "win-cuda-13.3-x64",
        "win-cuda-13.1-x64",
        "win-cuda-13-x64",
        "win-rocm-x64",
        "win-rocm-7.14-x64",
        "linux-vulkan-common_cpus-x64",
        "linux-vulkan-x64",
        "ubuntu-vulkan-x64",
        "ubuntu-vulkan-arm64",
        "ubuntu-x64",
        "win-vulkan-common_cpus-x64",
        "win-vulkan-x64",
        "win-avx512-x64",
        "win-common_cpus-x64",
        "win-cpu-x64",
        "win-cpu-arm64",
        "win-noavx-x64",
        "linux-avx2-x64",
        "linux-avx512-x64",
        "linux-common_cpus-x64",
        "linux-cpu-x64",
        "linux-arm64",
        "linux-common_cpus-arm64",
        "linux-cpu-arm64",
        "linux-vulkan-arm64",
        "linux-aarch64-vulkan-arm64",
        "linux-cuda-13-arm64",
        "linux-cuda-13.4-arm64",
        "ubuntu-arm64",
        "ubuntu-cuda-13.4-arm64",
        "ubuntu-cuda-13.4-x64",
        "macos-arm64",
        "macos-x64",
        "macos-avx2-x64",
        "backend-a",
    ] {
        cases.push((
            case_name("setting_update", &format!("maps_{id}")),
            setting_update_input("version_backend", &format!("b10205/{id}"), None),
        ));
    }
    cases
}

#[tokio::test]
#[ignore]
async fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts").join(SET);
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);

    let mut cases = feature_cases(&root);
    cases.extend(supported_cases());
    cases.extend(prioritize_cases());
    cases.extend(merge_cases());
    cases.extend(latest_cases());
    cases.extend(update_check_cases());
    cases.extend(migrate_cases());
    cases.extend(setting_update_cases());

    let mut names = Vec::new();
    for (name, input) in cases {
        assert!(!names.contains(&name), "duplicate case name {name}");
        let expected = run(&input).await;
        let doc = json!({
            "name": name,
            "source": {"file": SOURCE, "commit": commit, "provider": PROVIDER},
            "comparator": "json-exact",
            "input": input,
            "expected": expected,
        });
        std::fs::write(out.join(format!("{name}.json")), serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        names.push(name);
    }
    let index = json!({
        "source": {"file": SOURCE, "commit": commit, "provider": PROVIDER},
        "comparator": "json-exact",
        "note": "Hardware-gated backend decisions of the upstream provider. Call the command named by input.kind with the other input fields as its arguments and compare the result with expected as a JSON tree; a command that returns Err(String) is expected as {error}.",
        "comparator_notes": {
            "features": "get_supported_features(os_type, cpu_extensions, gpus) -> SupportedFeatures. input.gpus is the wire shape of this plugin's GpuInfo (driver_version required; vendor, nvidia_info{compute_capability}, vulkan_info{api_version, device_id} optional; unknown fields ignored). The features_profile_* cases are the machines of tests/fixtures/hardware/profiles.json: their own `features` block is that TypeScript test's assumption, not this command's output (driver_version \"fixture\" clears every CUDA floor), and `api_version: \"1.3\"` was added because this plugin's VulkanInfo requires it.",
            "supported": "determine_supported_backends(os_type, arch, features) -> string[] in the plugin's order, or {error: \"Unsupported system type: <os>-<arch>\"}.",
            "prioritize": "prioritize_backends(version_backends, has_enough_gpu_memory) -> BestBackendResult {backend_string, version, backend_type}, or {error: \"No backends available\"}.",
            "merge": "list_supported_backends(remote, local) -> the merged list sorted newest first; `order` is always serialised (0 when the input omitted it).",
            "latest": "find_latest_version_for_backend(version_backends, backend_type) -> \"<version>/<backend>\" with the original backend spelling, or null.",
            "update_check": "check_backend_for_updates(current, version_backends) -> UpdateCheckResult {update_needed, new_version, target_backend}, or {error: \"Invalid current backend format: <current>\"}.",
            "migrate": "should_migrate_backend(stored_type, version_backends) -> the mapped id, or null.",
            "setting_update": "handle_setting_update(key, value, stored_type) -> SettingUpdateResult, or {error: \"Invalid backend format: <value>\"}. The setting_update_maps_* cases pin map_old_backend_to_new(<id>) as expected.effective_backend_type.",
            "known_divergence": {
                "merge_remote_without_order_defaults_to_zero": "The core's `listSupportedBackends` copies an input entry as it is, so an entry that came without `order` stays without it where `#[serde(default)]` wrote `order: 0` here. Every reader uses `order ?? 0`; the replay asserts the field absent for such entries.",
            },
            "behaviour_not_captured": "get_local_installed_backends, remove_old_backend_versions, install_bundled_backend and fetch_manifest_http1 touch the disk or the network and are not pinned here.",
        },
        "cases": names,
    });
    std::fs::write(out.join("index.json"), serde_json::to_string_pretty(&index).unwrap() + "\n").unwrap();
    eprintln!("wrote {} {SET} fixtures", names.len());
}
