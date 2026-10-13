use crate::commands::*;
use crate::types::{CpuStaticInfo, GpuInfo, Vendor};
use tauri::test::mock_app;

#[test]
fn test_system_info() {
    let info = get_system_info();
    println!("System Static Info: {:?}", info);
}

#[test]
fn test_system_usage() {
    let usage = get_system_usage();
    println!("System Usage Info: {:?}", usage);
}

#[test]
fn test_unsupported_gpu_usage_is_explicitly_unavailable() {
    let gpu = GpuInfo {
        name: "Test GPU".to_string(),
        total_memory: 4096,
        vendor: Vendor::Intel,
        uuid: "test-gpu".to_string(),
        driver_version: "test".to_string(),
        nvidia_info: None,
        vulkan_info: None,
    };

    let usage = gpu.get_usage_unsupported();
    assert!(!usage.available);
    assert_eq!(usage.used_memory, 0);
    assert_eq!(usage.total_memory, 0);
    assert_eq!(usage.utilization_percent, None);
    assert_eq!(usage.temperature_c, None);
    assert_eq!(usage.power_w, None);
    assert_eq!(usage.power_limit_w, None);
    assert_eq!(usage.clock_graphics_mhz, None);
    assert_eq!(usage.clock_memory_mhz, None);
}

#[cfg(test)]
mod cpu_tests {
    use super::*;

    #[test]
    fn test_cpu_static_info_new() {
        let cpu_info = CpuStaticInfo::new();

        // Test that all fields are populated
        assert!(!cpu_info.name.is_empty());
        assert_ne!(cpu_info.name, "unknown"); // Should have detected a CPU name
        assert!(cpu_info.core_count > 0);
        assert!(!cpu_info.arch.is_empty());

        // Architecture should be one of the expected values
        assert!(
            cpu_info.arch == "aarch64"
                || cpu_info.arch == "arm64"
                || cpu_info.arch == "x86_64"
                || cpu_info.arch == std::env::consts::ARCH
        );

        // Extensions should be a valid list (can be empty on non-x86)

        println!("CPU Info: {:?}", cpu_info);
    }

    #[test]
    fn test_cpu_info_consistency() {
        // Test that multiple calls return consistent information
        let info1 = CpuStaticInfo::new();
        let info2 = CpuStaticInfo::new();

        assert_eq!(info1.name, info2.name);
        assert_eq!(info1.core_count, info2.core_count);
        assert_eq!(info1.arch, info2.arch);
        assert_eq!(info1.extensions, info2.extensions);
    }

    #[test]
    fn test_cpu_name_not_empty() {
        let cpu_info = CpuStaticInfo::new();
        assert!(!cpu_info.name.is_empty());
        assert!(cpu_info.name.len() > 0);
    }

    #[test]
    fn test_core_count_positive() {
        let cpu_info = CpuStaticInfo::new();
        assert!(cpu_info.core_count > 0);
    }

    #[test]
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    fn test_x86_extensions() {
        let cpu_info = CpuStaticInfo::new();

        // On x86/x86_64, we should always have at least FPU
        assert!(cpu_info.extensions.contains(&"fpu".to_string()));

        // Check that all extensions are valid x86 feature names
        let valid_extensions = [
            "fpu",
            "mmx",
            "sse",
            "sse2",
            "sse3",
            "ssse3",
            "sse4_1",
            "sse4_2",
            "pclmulqdq",
            "avx",
            "avx2",
            "avx512_f",
            "avx512_dq",
            "avx512_ifma",
            "avx512_pf",
            "avx512_er",
            "avx512_cd",
            "avx512_bw",
            "avx512_vl",
            "avx512_vbmi",
            "avx512_vbmi2",
            "avx512_vnni",
            "avx512_bitalg",
            "avx512_vpopcntdq",
            "avx512_vp2intersect",
            "aes",
            "f16c",
        ];

        for ext in &cpu_info.extensions {
            assert!(
                valid_extensions.contains(&ext.as_str()),
                "Unknown extension: {}",
                ext
            );
        }
    }

    #[test]
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
    fn test_non_x86_extensions() {
        let cpu_info = CpuStaticInfo::new();

        // On non-x86 architectures, extensions should be empty
        assert!(cpu_info.extensions.is_empty());
    }

    #[test]
    fn test_arch_detection() {
        let cpu_info = CpuStaticInfo::new();

        // Architecture should be a valid string
        assert!(!cpu_info.arch.is_empty());

        // Should be one of the common architectures
        let common_archs = ["x86_64", "aarch64", "arm", "arm64", "x86"];
        let is_common_arch = common_archs.iter().any(|&arch| cpu_info.arch == arch);
        let is_compile_time_arch = cpu_info.arch == std::env::consts::ARCH;

        assert!(
            is_common_arch || is_compile_time_arch,
            "Unexpected architecture: {}",
            cpu_info.arch
        );
    }

    #[test]
    fn test_cpu_info_serialization() {
        let cpu_info = CpuStaticInfo::new();

        // Test that the struct can be serialized (since it derives Serialize)
        let serialized = serde_json::to_string(&cpu_info);
        assert!(serialized.is_ok());

        let json_str = serialized.unwrap();
        assert!(json_str.contains("name"));
        assert!(json_str.contains("core_count"));
        assert!(json_str.contains("arch"));
        assert!(json_str.contains("extensions"));
    }
}
