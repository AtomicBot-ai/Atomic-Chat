use sysinfo::System;

use crate::types::CpuStaticInfo;

impl CpuStaticInfo {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_all();

        let name = system
            .cpus()
            .first()
            .map(|cpu| {
                let brand = cpu.brand();
                if brand.is_empty() {
                    cpu.name()
                } else {
                    brand
                }
            })
            .unwrap_or("unknown")
            .to_string();

        CpuStaticInfo {
            name,
            core_count: System::physical_core_count().unwrap_or(0),
            arch: System::cpu_arch(),
            extensions: CpuStaticInfo::get_extensions(),
        }
    }

    // TODO: see if we need to check for all CPU extensions
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    fn get_extensions() -> Vec<String> {
        let mut exts = vec![];

        // fpu is always present on modern x86 processors,
        // but is_x86_feature_detected doesn't support it
        exts.push("fpu".to_string());
        if is_x86_feature_detected!("aes") {
            exts.push("aes".to_string());
        }
        if is_x86_feature_detected!("pclmulqdq") {
            exts.push("pclmulqdq".to_string());
        }
        if is_x86_feature_detected!("rdrand") {
            exts.push("rdrand".to_string());
        }
        if is_x86_feature_detected!("rdseed") {
            exts.push("rdseed".to_string());
        }
        if is_x86_feature_detected!("tsc") {
            exts.push("tsc".to_string());
        }
        if is_x86_feature_detected!("mmx") {
            exts.push("mmx".to_string());
        }
        if is_x86_feature_detected!("sse") {
            exts.push("sse".to_string());
        }
        if is_x86_feature_detected!("sse2") {
            exts.push("sse2".to_string());
        }
        if is_x86_feature_detected!("sse3") {
            exts.push("sse3".to_string());
        }
        if is_x86_feature_detected!("ssse3") {
            exts.push("ssse3".to_string());
        }
        if is_x86_feature_detected!("sse4.1") {
            exts.push("sse4_1".to_string());
        }
        if is_x86_feature_detected!("sse4.2") {
            exts.push("sse4_2".to_string());
        }
        if is_x86_feature_detected!("sse4a") {
            exts.push("sse4a".to_string());
        }
        if is_x86_feature_detected!("sha") {
            exts.push("sha".to_string());
        }
        if is_x86_feature_detected!("avx") {
            exts.push("avx".to_string());
        }
        if is_x86_feature_detected!("avx2") {
            exts.push("avx2".to_string());
        }
        if is_x86_feature_detected!("avx512f") {
            exts.push("avx512_f".to_string());
        }
        if is_x86_feature_detected!("avx512cd") {
            exts.push("avx512_cd".to_string());
        }
        if is_x86_feature_detected!("avx512er") {
            exts.push("avx512_er".to_string());
        }
        if is_x86_feature_detected!("avx512pf") {
            exts.push("avx512_pf".to_string());
        }
        if is_x86_feature_detected!("avx512bw") {
            exts.push("avx512_bw".to_string());
        }
        if is_x86_feature_detected!("avx512dq") {
            exts.push("avx512_dq".to_string());
        }
        if is_x86_feature_detected!("avx512vl") {
            exts.push("avx512_vl".to_string());
        }
        if is_x86_feature_detected!("avx512ifma") {
            exts.push("avx512_ifma".to_string());
        }
        if is_x86_feature_detected!("avx512vbmi") {
            exts.push("avx512_vbmi".to_string());
        }
        if is_x86_feature_detected!("avx512vpopcntdq") {
            exts.push("avx512_vpopcntdq".to_string());
        }
        if is_x86_feature_detected!("avx512vbmi2") {
            exts.push("avx512_vbmi2".to_string());
        }
        if is_x86_feature_detected!("avx512bitalg") {
            exts.push("avx512_bitalg".to_string());
        }
        if is_x86_feature_detected!("avx512vnni") {
            exts.push("avx512_vnni".to_string());
        }
        if is_x86_feature_detected!("avx512vp2intersect") {
            exts.push("avx512_vp2intersect".to_string());
        }
        if is_x86_feature_detected!("f16c") {
            exts.push("f16c".to_string());
        }
        if is_x86_feature_detected!("fma") {
            exts.push("fma".to_string());
        }
        if is_x86_feature_detected!("bmi1") {
            exts.push("bmi1".to_string());
        }
        if is_x86_feature_detected!("bmi2") {
            exts.push("bmi2".to_string());
        }
        if is_x86_feature_detected!("abm") {
            exts.push("abm".to_string());
        }
        if is_x86_feature_detected!("lzcnt") {
            exts.push("lzcnt".to_string());
        }
        if is_x86_feature_detected!("tbm") {
            exts.push("tbm".to_string());
        }
        if is_x86_feature_detected!("popcnt") {
            exts.push("popcnt".to_string());
        }
        if is_x86_feature_detected!("fxsr") {
            exts.push("fxsr".to_string());
        }
        if is_x86_feature_detected!("xsave") {
            exts.push("xsave".to_string());
        }
        if is_x86_feature_detected!("xsaveopt") {
            exts.push("xsaveopt".to_string());
        }
        if is_x86_feature_detected!("xsaves") {
            exts.push("xsaves".to_string());
        }
        if is_x86_feature_detected!("xsavec") {
            exts.push("xsavec".to_string());
        }
        if is_x86_feature_detected!("cmpxchg16b") {
            exts.push("cmpxchg16b".to_string());
        }
        if is_x86_feature_detected!("adx") {
            exts.push("adx".to_string());
        }
        if is_x86_feature_detected!("rtm") {
            exts.push("rtm".to_string());
        }

        exts
    }

    #[cfg(target_arch = "aarch64")]
    fn get_extensions() -> Vec<String> {
        let mut exts = vec![];
        if std::arch::is_aarch64_feature_detected!("neon") {
            exts.push("neon".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("pmull") {
            exts.push("pmull".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("fp") {
            exts.push("fp".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("fp16") {
            exts.push("fp16".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("sve") {
            exts.push("sve".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("crc") {
            exts.push("crc".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("crypto") {
            exts.push("crypto".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("lse") {
            exts.push("lse".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("rdm") {
            exts.push("rdm".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("rcpc") {
            exts.push("rcpc".to_string());
        }
        if std::arch::is_aarch64_feature_detected!("dotprod") {
            exts.push("dotprod".to_string());
        }

        exts
    }

    // Cortex always returns empty list for non-x86/aarch64
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64")))]
    fn get_extensions() -> Vec<String> {
        vec![]
    }
}
