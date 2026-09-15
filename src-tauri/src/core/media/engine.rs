//! The built-in media engine (tracker Task 30, decision D39).
//!
//! Radium makes images itself with stable-diffusion.cpp (MIT), the image and
//! video counterpart of the llama.cpp that Chat already uses. This module
//! decides which published build suits the computer and pins every build to a
//! reviewed release with its size and SHA-256, so nothing unverified is run.

use serde::Serialize;

/// The reviewed stable-diffusion.cpp release every build comes from.
pub const ENGINE_RELEASE: &str = "master-866-42d6c0a";

const RELEASE_BASE_URL: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/download";

/// One published build of the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineVariant {
    /// NVIDIA graphics on Windows, with the CUDA runtime alongside.
    WindowsCuda12,
    /// AMD, Intel or other Vulkan-capable graphics on Windows.
    WindowsVulkan,
    /// Windows with no usable graphics.
    WindowsCpu,
    LinuxVulkan,
    LinuxCpu,
    /// Apple silicon.
    MacosMetal,
}

/// A file to download for a build, pinned by size and checksum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineAsset {
    pub name: &'static str,
    pub url: String,
    pub sha256: &'static str,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Other,
}

/// What the engine choice needs to know about one graphics device. Built from
/// the hardware plugin's GPU list where that plugin is present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuSummary {
    pub vendor: GpuVendor,
    pub name: String,
    pub supports_vulkan: bool,
    pub has_cuda_driver: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Windows,
    Linux,
    Macos,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostArch {
    X86_64,
    Aarch64,
    Other,
}

/// The build that suits this computer, or `None` where no build is published.
///
/// Unlike llama.cpp's choice for chat, graphics built into the processor still
/// get the Vulkan build: image generation is far heavier than text, and the
/// first image on this PC's built-in Radeon graphics took 84 s through Vulkan.
pub fn choose_engine_variant(
    os: HostOs,
    arch: HostArch,
    gpus: &[GpuSummary],
) -> Option<EngineVariant> {
    let any_cuda = gpus
        .iter()
        .any(|gpu| gpu.vendor == GpuVendor::Nvidia && gpu.has_cuda_driver);
    let any_vulkan = gpus.iter().any(|gpu| gpu.supports_vulkan);
    match (os, arch) {
        (HostOs::Windows, HostArch::X86_64) if any_cuda => Some(EngineVariant::WindowsCuda12),
        (HostOs::Windows, HostArch::X86_64) if any_vulkan => Some(EngineVariant::WindowsVulkan),
        (HostOs::Windows, HostArch::X86_64) => Some(EngineVariant::WindowsCpu),
        // No Linux CUDA build is published, so NVIDIA on Linux goes through Vulkan.
        (HostOs::Linux, HostArch::X86_64) if any_vulkan => Some(EngineVariant::LinuxVulkan),
        (HostOs::Linux, HostArch::X86_64) => Some(EngineVariant::LinuxCpu),
        (HostOs::Macos, HostArch::Aarch64) => Some(EngineVariant::MacosMetal),
        _ => None,
    }
}

/// The files to download for a build.
pub fn engine_assets(variant: EngineVariant) -> Vec<EngineAsset> {
    let pinned: &[(&'static str, &'static str, u64)] = match variant {
        EngineVariant::WindowsCuda12 => &[
            (
                "sd-master-42d6c0a-bin-win-cuda12-x64.zip",
                "de4f740b693f46df612d3219f4dea717c0776f3815bb65a3044956e777e338e5",
                336_661_721,
            ),
            (
                "cudart-sd-bin-win-cu12-x64.zip",
                "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
                563_452_046,
            ),
        ],
        EngineVariant::WindowsVulkan => &[(
            "sd-master-42d6c0a-bin-win-vulkan-x64.zip",
            "d0355deb0d4b4b0e0b74f631b7b015db91b9a75a340f275c245d97571d77b689",
            39_092_706,
        )],
        EngineVariant::WindowsCpu => &[(
            "sd-master-42d6c0a-bin-win-cpu-x64.zip",
            "79efdb99598d523662ea33af3d3d0bb04ae9b4c52dce38327a659a0033ea0163",
            24_342_573,
        )],
        EngineVariant::LinuxVulkan => &[(
            "sd-master-42d6c0a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip",
            "e219ff6124abf367b5ef7089b10cc1efd870478cece4561ed18a828f0a2b2292",
            46_411_683,
        )],
        EngineVariant::LinuxCpu => &[(
            "sd-master-42d6c0a-bin-Linux-Ubuntu-24.04-x86_64.zip",
            "7480a7097cd3bd91627dd4d806af7e273f0b9f8dfdd4b37be47bfccdae693f06",
            33_288_391,
        )],
        EngineVariant::MacosMetal => &[(
            "sd-master-42d6c0a-bin-Darwin-macOS-26.6.2-arm64.zip",
            "ff6a473344c4b339f9066bfc3026b73359bec3ed697ba2db5f2bcd041ec01d78",
            50_359_739,
        )],
    };
    pinned
        .iter()
        .map(|&(name, sha256, size)| EngineAsset {
            name,
            url: format!("{RELEASE_BASE_URL}/{ENGINE_RELEASE}/{name}"),
            sha256,
            size,
        })
        .collect()
}

/// Where the engine lives, relative to Radium's data folder.
pub const ENGINE_DIR: &str = "media/engine";

/// One archive to download for the engine, as the download manager takes it:
/// `save_path` is relative to Radium's data folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineDownload {
    pub url: String,
    pub save_path: String,
    pub sha256: &'static str,
    pub size: u64,
}

/// Everything needed to install the engine for one build, and whether it is
/// already installed. Paths are relative to Radium's data folder and use `/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineInstallPlan {
    pub release: &'static str,
    pub variant: EngineVariant,
    pub install_dir: String,
    pub executable: String,
    pub downloads: Vec<EngineDownload>,
    pub installed: bool,
}

/// The folder name for a build.
pub fn variant_dir_name(variant: EngineVariant) -> &'static str {
    match variant {
        EngineVariant::WindowsCuda12 => "windows_cuda12",
        EngineVariant::WindowsVulkan => "windows_vulkan",
        EngineVariant::WindowsCpu => "windows_cpu",
        EngineVariant::LinuxVulkan => "linux_vulkan",
        EngineVariant::LinuxCpu => "linux_cpu",
        EngineVariant::MacosMetal => "macos_metal",
    }
}

/// The install plan for a build under `data_dir`.
pub fn engine_install_plan(
    data_dir: &std::path::Path,
    variant: EngineVariant,
) -> EngineInstallPlan {
    let release_dir = format!("{ENGINE_DIR}/{ENGINE_RELEASE}");
    let install_dir = format!("{release_dir}/{}", variant_dir_name(variant));
    let program = match variant {
        EngineVariant::WindowsCuda12 | EngineVariant::WindowsVulkan | EngineVariant::WindowsCpu => {
            "sd-server.exe"
        }
        EngineVariant::LinuxVulkan | EngineVariant::LinuxCpu | EngineVariant::MacosMetal => {
            "sd-server"
        }
    };
    // Radium runs the engine's server, which keeps the model loaded between
    // images; the archive also has a one-shot tool, which is not used.
    let executable = format!("{install_dir}/{program}");
    // Archives are saved apart from the unpacked engine, so unpacking one build
    // never mixes with another's files.
    let downloads = engine_assets(variant)
        .into_iter()
        .map(|asset| EngineDownload {
            save_path: format!("{release_dir}/downloads/{}", asset.name),
            url: asset.url,
            sha256: asset.sha256,
            size: asset.size,
        })
        .collect();
    // The program itself must be there; a folder by that name is not an engine.
    let installed = data_dir.join(&executable).is_file();
    EngineInstallPlan {
        release: ENGINE_RELEASE,
        variant,
        install_dir,
        executable,
        downloads,
        installed,
    }
}

/// This computer's system and chip, from Rust's target names
/// (`std::env::consts::OS` and `ARCH`).
pub fn host_platform(os: &str, arch: &str) -> (HostOs, HostArch) {
    let os = match os {
        "windows" => HostOs::Windows,
        "linux" => HostOs::Linux,
        "macos" => HostOs::Macos,
        _ => HostOs::Other,
    };
    let arch = match arch {
        "x86_64" => HostArch::X86_64,
        "aarch64" => HostArch::Aarch64,
        _ => HostArch::Other,
    };
    (os, arch)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_VARIANTS: [EngineVariant; 6] = [
        EngineVariant::WindowsCuda12,
        EngineVariant::WindowsVulkan,
        EngineVariant::WindowsCpu,
        EngineVariant::LinuxVulkan,
        EngineVariant::LinuxCpu,
        EngineVariant::MacosMetal,
    ];

    fn gpu(
        vendor: GpuVendor,
        name: &str,
        supports_vulkan: bool,
        has_cuda_driver: bool,
    ) -> GpuSummary {
        GpuSummary {
            vendor,
            name: name.to_string(),
            supports_vulkan,
            has_cuda_driver,
        }
    }

    fn asset_names(variant: EngineVariant) -> Vec<&'static str> {
        engine_assets(variant)
            .into_iter()
            .map(|asset| asset.name)
            .collect()
    }

    #[test]
    fn nvidia_cards_get_the_cuda_build_and_its_runtime() {
        // The user's dual-3090 desktop.
        let desktop = [
            gpu(GpuVendor::Nvidia, "NVIDIA GeForce RTX 3090", true, true),
            gpu(GpuVendor::Nvidia, "NVIDIA GeForce RTX 3090", true, true),
        ];

        let variant = choose_engine_variant(HostOs::Windows, HostArch::X86_64, &desktop);

        assert_eq!(variant, Some(EngineVariant::WindowsCuda12));
        assert_eq!(
            asset_names(EngineVariant::WindowsCuda12),
            [
                "sd-master-42d6c0a-bin-win-cuda12-x64.zip",
                "cudart-sd-bin-win-cu12-x64.zip"
            ]
        );
    }

    #[test]
    fn amd_or_intel_graphics_use_vulkan_even_when_built_into_the_processor() {
        // This PC: the Radeon graphics built into a Ryzen 7 7735U, where the
        // Vulkan build made the first image in 84 s.
        let laptop = [gpu(GpuVendor::Amd, "AMD Radeon(TM) Graphics", true, false)];
        let intel = [gpu(
            GpuVendor::Intel,
            "Intel(R) Iris(R) Xe Graphics",
            true,
            false,
        )];

        assert_eq!(
            choose_engine_variant(HostOs::Windows, HostArch::X86_64, &laptop),
            Some(EngineVariant::WindowsVulkan)
        );
        assert_eq!(
            choose_engine_variant(HostOs::Windows, HostArch::X86_64, &intel),
            Some(EngineVariant::WindowsVulkan)
        );
    }

    #[test]
    fn an_nvidia_card_without_a_cuda_driver_still_uses_its_graphics_through_vulkan() {
        let gpus = [gpu(
            GpuVendor::Nvidia,
            "NVIDIA GeForce GTX 1060",
            true,
            false,
        )];

        assert_eq!(
            choose_engine_variant(HostOs::Windows, HostArch::X86_64, &gpus),
            Some(EngineVariant::WindowsVulkan)
        );
    }

    #[test]
    fn cuda_wins_over_vulkan_when_both_kinds_of_graphics_are_present() {
        let gpus = [
            gpu(GpuVendor::Intel, "Intel(R) UHD Graphics", true, false),
            gpu(GpuVendor::Nvidia, "NVIDIA GeForce RTX 3090", true, true),
        ];

        assert_eq!(
            choose_engine_variant(HostOs::Windows, HostArch::X86_64, &gpus),
            Some(EngineVariant::WindowsCuda12)
        );
    }

    #[test]
    fn no_usable_graphics_falls_back_to_the_processor_build() {
        let unusable = [gpu(
            GpuVendor::Other,
            "Microsoft Basic Display Adapter",
            false,
            false,
        )];

        assert_eq!(
            choose_engine_variant(HostOs::Windows, HostArch::X86_64, &[]),
            Some(EngineVariant::WindowsCpu)
        );
        assert_eq!(
            choose_engine_variant(HostOs::Windows, HostArch::X86_64, &unusable),
            Some(EngineVariant::WindowsCpu)
        );
    }

    #[test]
    fn other_platforms_get_their_own_builds_or_none() {
        let nvidia = [gpu(
            GpuVendor::Nvidia,
            "NVIDIA GeForce RTX 3090",
            true,
            true,
        )];

        // No Linux CUDA build is published, so Linux uses Vulkan.
        assert_eq!(
            choose_engine_variant(HostOs::Linux, HostArch::X86_64, &nvidia),
            Some(EngineVariant::LinuxVulkan)
        );
        assert_eq!(
            choose_engine_variant(HostOs::Linux, HostArch::X86_64, &[]),
            Some(EngineVariant::LinuxCpu)
        );
        assert_eq!(
            choose_engine_variant(HostOs::Macos, HostArch::Aarch64, &[]),
            Some(EngineVariant::MacosMetal)
        );
        assert_eq!(
            choose_engine_variant(HostOs::Windows, HostArch::Aarch64, &nvidia),
            None
        );
        assert_eq!(
            choose_engine_variant(HostOs::Macos, HostArch::X86_64, &[]),
            None
        );
        assert_eq!(
            choose_engine_variant(HostOs::Other, HostArch::X86_64, &[]),
            None
        );
    }

    #[test]
    fn every_build_is_pinned_to_the_reviewed_release_with_its_size_and_checksum() {
        for variant in ALL_VARIANTS {
            let assets = engine_assets(variant);
            assert!(!assets.is_empty(), "{variant:?} has no files");
            for asset in assets {
                assert_eq!(
                    asset.url,
                    format!("{RELEASE_BASE_URL}/{ENGINE_RELEASE}/{}", asset.name),
                    "{variant:?}"
                );
                assert_eq!(asset.sha256.len(), 64, "{}", asset.name);
                assert!(
                    asset
                        .sha256
                        .chars()
                        .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
                    "{}",
                    asset.name
                );
                assert!(asset.size > 0, "{}", asset.name);
            }
        }
        // The Vulkan build exactly as it was verified on this PC for the first image.
        assert_eq!(
            engine_assets(EngineVariant::WindowsVulkan),
            [EngineAsset {
                name: "sd-master-42d6c0a-bin-win-vulkan-x64.zip",
                url: format!(
                    "{RELEASE_BASE_URL}/{ENGINE_RELEASE}/sd-master-42d6c0a-bin-win-vulkan-x64.zip"
                ),
                sha256: "d0355deb0d4b4b0e0b74f631b7b015db91b9a75a340f275c245d97571d77b689",
                size: 39_092_706,
            }]
        );
    }
    #[test]
    fn the_install_plan_keeps_everything_in_the_media_engine_folder_for_this_release() {
        let data = tempfile::TempDir::new().unwrap();

        let plan = engine_install_plan(data.path(), EngineVariant::WindowsVulkan);

        assert_eq!(plan.release, ENGINE_RELEASE);
        assert_eq!(plan.variant, EngineVariant::WindowsVulkan);
        assert_eq!(
            plan.install_dir,
            "media/engine/master-866-42d6c0a/windows_vulkan"
        );
        assert_eq!(
            plan.executable,
            "media/engine/master-866-42d6c0a/windows_vulkan/sd-server.exe"
        );
        // Archives are saved apart from the unpacked engine, and each keeps the
        // exact checksum and size it is pinned to.
        assert_eq!(
            plan.downloads,
            [EngineDownload {
                url: format!(
                    "{RELEASE_BASE_URL}/{ENGINE_RELEASE}/sd-master-42d6c0a-bin-win-vulkan-x64.zip"
                ),
                save_path:
                    "media/engine/master-866-42d6c0a/downloads/sd-master-42d6c0a-bin-win-vulkan-x64.zip"
                        .to_string(),
                sha256: "d0355deb0d4b4b0e0b74f631b7b015db91b9a75a340f275c245d97571d77b689",
                size: 39_092_706,
            }]
        );
        assert!(!plan.installed);
    }

    #[test]
    fn the_engine_counts_as_installed_once_its_program_is_unpacked() {
        let data = tempfile::TempDir::new().unwrap();
        let plan = engine_install_plan(data.path(), EngineVariant::WindowsCpu);

        // A folder where the program should be is not an installed engine.
        std::fs::create_dir_all(data.path().join(&plan.executable)).unwrap();
        assert!(!engine_install_plan(data.path(), EngineVariant::WindowsCpu).installed);
        std::fs::remove_dir(data.path().join(&plan.executable)).unwrap();

        std::fs::write(data.path().join(&plan.executable), b"program").unwrap();
        assert!(engine_install_plan(data.path(), EngineVariant::WindowsCpu).installed);
        // Installing one build says nothing about another.
        assert!(!engine_install_plan(data.path(), EngineVariant::WindowsVulkan).installed);
    }

    #[test]
    fn the_cuda_build_downloads_both_archives_for_one_install() {
        let data = tempfile::TempDir::new().unwrap();

        let plan = engine_install_plan(data.path(), EngineVariant::WindowsCuda12);

        assert_eq!(
            plan.install_dir,
            "media/engine/master-866-42d6c0a/windows_cuda12"
        );
        let saved: Vec<&str> = plan
            .downloads
            .iter()
            .map(|d| d.save_path.as_str())
            .collect();
        assert_eq!(
            saved,
            [
                "media/engine/master-866-42d6c0a/downloads/sd-master-42d6c0a-bin-win-cuda12-x64.zip",
                "media/engine/master-866-42d6c0a/downloads/cudart-sd-bin-win-cu12-x64.zip"
            ]
        );
    }

    #[test]
    fn the_program_has_no_exe_suffix_outside_windows() {
        let data = tempfile::TempDir::new().unwrap();

        assert_eq!(
            engine_install_plan(data.path(), EngineVariant::LinuxCpu).executable,
            "media/engine/master-866-42d6c0a/linux_cpu/sd-server"
        );
        assert_eq!(
            engine_install_plan(data.path(), EngineVariant::MacosMetal).executable,
            "media/engine/master-866-42d6c0a/macos_metal/sd-server"
        );
        assert_eq!(variant_dir_name(EngineVariant::LinuxVulkan), "linux_vulkan");
    }

    #[test]
    fn the_host_platform_comes_from_rust_target_names() {
        assert_eq!(
            host_platform("windows", "x86_64"),
            (HostOs::Windows, HostArch::X86_64)
        );
        assert_eq!(
            host_platform("linux", "x86_64"),
            (HostOs::Linux, HostArch::X86_64)
        );
        assert_eq!(
            host_platform("macos", "aarch64"),
            (HostOs::Macos, HostArch::Aarch64)
        );
        assert_eq!(
            host_platform("windows", "aarch64"),
            (HostOs::Windows, HostArch::Aarch64)
        );
        assert_eq!(
            host_platform("freebsd", "riscv64"),
            (HostOs::Other, HostArch::Other)
        );
    }
}
