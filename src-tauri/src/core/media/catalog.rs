//! The built-in engine's model catalog (tracker Task 30 S04).
//!
//! Every model Radium offers to download for its own engine is listed here,
//! pinned to a Hugging Face commit with each file's exact size and SHA-256 and
//! the model's licence, so what is downloaded is exactly what was reviewed.
//! Files are saved with Radium's existing download manager, which refuses a
//! file whose size or checksum does not match.
//!
//! A model is offered in several sizes (quantisations) of its main file, so a
//! computer short on memory can take a smaller one. The parts every size
//! shares, such as the VAE and text encoders, are listed once and downloaded
//! once.

use std::path::Path;

use serde::Serialize;

/// Where models live, relative to Radium's data folder.
pub const MODELS_DIR: &str = "media/models";

/// Joins a model and one of its sizes in the id the Media page uses:
/// `sd-1.5@q4_0`. A model id on its own means its default size.
pub const QUANT_SEPARATOR: char = '@';

/// What a file is for; each role is passed to the engine with its own option.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelFileRole {
    /// A single file holding the whole model (Stable Diffusion 1.x and XL).
    Model,
    /// The diffusion part of a model split into parts (FLUX, Wan).
    DiffusionModel,
    Vae,
    ClipL,
    T5xxl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTask {
    TextToImage,
    TextToVideo,
}

/// One file of a model, pinned to a Hugging Face commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogFile {
    pub role: ModelFileRole,
    pub repo: &'static str,
    /// A full commit hash, never a branch name, so the file cannot change.
    pub revision: &'static str,
    /// The path inside the repository.
    pub file: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

impl CatalogFile {
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.revision, self.file
        )
    }

    /// The file's own name, without the folders inside its repository.
    pub fn file_name(&self) -> &'static str {
        self.file.rsplit('/').next().unwrap_or(self.file)
    }
}

/// One size of a model's main file. A smaller file downloads and loads faster
/// and needs less memory, and loses a little detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogQuant {
    /// Plain lowercase, such as `q4_0`.
    pub id: &'static str,
    /// As Hugging Face names it, such as `Q4_0`.
    pub label: &'static str,
    /// What choosing it means, in plain words.
    pub note: &'static str,
    pub file: CatalogFile,
}

/// Settings a model works well with out of the box.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct GenerationDefaults {
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg_scale: f32,
    pub sampler: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatalogModel {
    pub id: &'static str,
    pub label: &'static str,
    pub family: &'static str,
    pub license: &'static str,
    pub license_url: &'static str,
    pub tasks: &'static [ModelTask],
    /// Roughly how much graphics or shared memory its default size needs.
    pub min_memory_mb: u64,
    pub defaults: GenerationDefaults,
    /// The main file in every size offered, smallest first.
    pub quants: &'static [CatalogQuant],
    /// The size used when none is chosen.
    pub default_quant: &'static str,
    /// Parts every size shares, such as the VAE and text encoders.
    pub files: &'static [CatalogFile],
}

impl CatalogModel {
    pub fn quant(&self, id: &str) -> Option<&CatalogQuant> {
        self.quants.iter().find(|quant| quant.id == id)
    }

    /// The size used when none is chosen.
    pub fn standard_quant(&self) -> &CatalogQuant {
        self.quant(self.default_quant).unwrap_or(&self.quants[0])
    }

    /// Every file one size needs: its main file first, then the shared parts.
    pub fn files_for<'a>(&'a self, quant: &'a CatalogQuant) -> Vec<&'a CatalogFile> {
        std::iter::once(&quant.file).chain(self.files).collect()
    }
}

const APACHE_2: &str = "https://www.apache.org/licenses/LICENSE-2.0";

static CATALOG: [CatalogModel; 4] = [
    // Small enough for built-in graphics: the first built-in image was made
    // with its Q8_0 file on the laptop in 84 s (T30-S01).
    CatalogModel {
        id: "sd-1.5",
        label: "Stable Diffusion 1.5",
        family: "sd1",
        license: "creativeml-openrail-m",
        license_url: "https://huggingface.co/spaces/CompVis/stable-diffusion-license",
        tasks: &[ModelTask::TextToImage],
        min_memory_mb: 3_072,
        defaults: GenerationDefaults {
            width: 512,
            height: 512,
            steps: 20,
            cfg_scale: 7.0,
            sampler: "euler_a",
        },
        quants: &[
            CatalogQuant {
                id: "q4_0",
                label: "Q4_0",
                note: "Small and quick to load. Slightly softer detail.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "second-state/stable-diffusion-v1-5-GGUF",
                    revision: "031b5f5df991f511b3f5fa8fed6d99048ababb69",
                    file: "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf",
                    sha256: "b8944e9fe0b69b36ae1b5bb0185b3a7b8ef14347fe0fa9af6c64c4829022261f",
                    size: 1_566_768_416,
                },
            },
            CatalogQuant {
                id: "q5_1",
                label: "Q5_1",
                note: "A balance of size and detail.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "second-state/stable-diffusion-v1-5-GGUF",
                    revision: "031b5f5df991f511b3f5fa8fed6d99048ababb69",
                    file: "stable-diffusion-v1-5-pruned-emaonly-Q5_1.gguf",
                    sha256: "b1342857c5d5ba796b7f4e8b23ed45981afe71e3ce440f226b51e7df5d9c1dd9",
                    size: 1_640_564_256,
                },
            },
            CatalogQuant {
                id: "q8_0",
                label: "Q8_0",
                note: "Near full quality.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "second-state/stable-diffusion-v1-5-GGUF",
                    revision: "031b5f5df991f511b3f5fa8fed6d99048ababb69",
                    file: "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf",
                    sha256: "d0555243938c62faeefb4ac93f6c7a053ad373a4290c5256bce229aeb193bf94",
                    size: 1_763_578_176,
                },
            },
            CatalogQuant {
                id: "f16",
                label: "F16",
                note: "Full quality. The largest download and the most memory.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "second-state/stable-diffusion-v1-5-GGUF",
                    revision: "031b5f5df991f511b3f5fa8fed6d99048ababb69",
                    file: "stable-diffusion-v1-5-pruned-emaonly-f16.gguf",
                    sha256: "da017009aa86a3f46468857d95833435fe55e4a2856afab76ba7722ef8ee4d8b",
                    size: 2_132_586_944,
                },
            },
        ],
        default_quant: "q8_0",
        files: &[],
    },
    CatalogModel {
        id: "sdxl-1.0",
        label: "Stable Diffusion XL 1.0",
        family: "sdxl",
        license: "openrail++",
        license_url:
            "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md",
        tasks: &[ModelTask::TextToImage],
        min_memory_mb: 8_192,
        defaults: GenerationDefaults {
            width: 1024,
            height: 1024,
            steps: 25,
            cfg_scale: 7.0,
            sampler: "euler_a",
        },
        quants: &[
            CatalogQuant {
                id: "q4_0",
                label: "Q4_0",
                note: "Small and quick to load. Slightly softer detail.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "gpustack/stable-diffusion-xl-base-1.0-GGUF",
                    revision: "f00927e80a399ecb0bcacca868131d5e9d4e77aa",
                    file: "stable-diffusion-xl-base-1.0-Q4_0.gguf",
                    sha256: "4ab9818c9b3428eca96834c51fe294885608480991463f55bd9be53c822567c3",
                    size: 3_940_010_720,
                },
            },
            CatalogQuant {
                id: "q4_1",
                label: "Q4_1",
                note: "Small. A little sharper than Q4_0.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "gpustack/stable-diffusion-xl-base-1.0-GGUF",
                    revision: "f00927e80a399ecb0bcacca868131d5e9d4e77aa",
                    file: "stable-diffusion-xl-base-1.0-Q4_1.gguf",
                    sha256: "2803b0d3fa8ae8f885c74a58d6d11366a7ff30d5f62035154956d0f148b63c48",
                    size: 4_077_625_728,
                },
            },
            CatalogQuant {
                id: "q8_0",
                label: "Q8_0",
                note: "Near full quality.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "gpustack/stable-diffusion-xl-base-1.0-GGUF",
                    revision: "f00927e80a399ecb0bcacca868131d5e9d4e77aa",
                    file: "stable-diffusion-xl-base-1.0-Q8_0.gguf",
                    sha256: "2ef973152d2fbe27e37e4fd5ec3569dec1f828ee279975e60acc12bc78c9f981",
                    size: 5_040_957_760,
                },
            },
            CatalogQuant {
                id: "f16",
                label: "F16",
                note: "Full quality. The largest download and the most memory.",
                file: CatalogFile {
                    role: ModelFileRole::Model,
                    repo: "gpustack/stable-diffusion-xl-base-1.0-GGUF",
                    revision: "f00927e80a399ecb0bcacca868131d5e9d4e77aa",
                    file: "stable-diffusion-xl-base-1.0-FP16.gguf",
                    sha256: "5b6b74d5db577e2b6c358a16f4e2de7da822d4cbfb1fc33220e70dded1d2c25b",
                    size: 6_938_053_280,
                },
            },
        ],
        default_quant: "q4_0",
        files: &[
            // The engine's SDXL guide uses this VAE (MIT), which avoids
            // washed-out or black images at 16-bit precision.
            CatalogFile {
                role: ModelFileRole::Vae,
                repo: "madebyollin/sdxl-vae-fp16-fix",
                revision: "207b116dae70ace3637169f1ddd2434b91b3a8cd",
                file: "sdxl_vae.safetensors",
                sha256: "235745af8d86bf4a4c1b5b4f529868b37019a10f7c0b2e79ad0abca3a22bc6e1",
                size: 334_641_162,
            },
        ],
    },
    // All parts from one Apache-2.0 repository, so the gated official VAE is
    // not needed.
    CatalogModel {
        id: "flux.1-schnell",
        label: "FLUX.1 [schnell]",
        family: "flux",
        license: "apache-2.0",
        license_url: APACHE_2,
        tasks: &[ModelTask::TextToImage],
        min_memory_mb: 12_288,
        defaults: GenerationDefaults {
            width: 1024,
            height: 1024,
            steps: 4,
            cfg_scale: 1.0,
            sampler: "euler",
        },
        quants: &[
            CatalogQuant {
                id: "q4_0",
                label: "Q4_0",
                note: "Small and quick to load. Slightly softer detail.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "second-state/FLUX.1-schnell-GGUF",
                    revision: "8c45a2ba25e2d02bd34230989fb54983f39e44ec",
                    file: "flux1-schnell-Q4_0.gguf",
                    sha256: "b338a7ab5c81600a54be46c4cf950edb3761a52ae163e419beafd250976fb566",
                    size: 6_688_845_536,
                },
            },
            CatalogQuant {
                id: "q5_0",
                label: "Q5_0",
                note: "A balance of size and detail.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "second-state/FLUX.1-schnell-GGUF",
                    revision: "8c45a2ba25e2d02bd34230989fb54983f39e44ec",
                    file: "flux1-schnell-Q5_0.gguf",
                    sha256: "7324362f5366f404fbf662357f321d6335a889e3f2030f1788270323eebd9116",
                    size: 8_175_240_416,
                },
            },
            CatalogQuant {
                id: "q8_0",
                label: "Q8_0",
                note: "Near full quality.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "second-state/FLUX.1-schnell-GGUF",
                    revision: "8c45a2ba25e2d02bd34230989fb54983f39e44ec",
                    file: "flux1-schnell-Q8_0.gguf",
                    sha256: "7ccdc568ef7d33f37943302c80450a94a59370b48d62440fc2e5a3bf8520bf35",
                    size: 12_634_434_816,
                },
            },
            CatalogQuant {
                id: "f16",
                label: "F16",
                note: "Full quality. The largest download and the most memory.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "second-state/FLUX.1-schnell-GGUF",
                    revision: "8c45a2ba25e2d02bd34230989fb54983f39e44ec",
                    file: "flux1-schnell-f16.gguf",
                    sha256: "9a562470321fd77b6f85fa8a0807f51e9c1c754ecf7b5854821e8620526b0f67",
                    size: 23_782_411_040,
                },
            },
        ],
        default_quant: "q4_0",
        files: &[
            CatalogFile {
                role: ModelFileRole::Vae,
                repo: "second-state/FLUX.1-schnell-GGUF",
                revision: "8c45a2ba25e2d02bd34230989fb54983f39e44ec",
                file: "ae.safetensors",
                sha256: "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38",
                size: 335_304_388,
            },
            CatalogFile {
                role: ModelFileRole::ClipL,
                repo: "second-state/FLUX.1-schnell-GGUF",
                revision: "8c45a2ba25e2d02bd34230989fb54983f39e44ec",
                file: "clip_l.safetensors",
                sha256: "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
                size: 246_144_152,
            },
            CatalogFile {
                role: ModelFileRole::T5xxl,
                repo: "second-state/FLUX.1-schnell-GGUF",
                revision: "8c45a2ba25e2d02bd34230989fb54983f39e44ec",
                file: "t5xxl-Q4_K.gguf",
                sha256: "8b465525114b89011303969a035ef7e335821f13a32c4f31212912fb6511e128",
                size: 2_752_844_256,
            },
        ],
    },
    // Video. The engine's Wan 2.2 TI2V 5B guide: umt5 text encoder, Wan 2.2 VAE.
    CatalogModel {
        id: "wan2.2-ti2v-5b",
        label: "Wan 2.2 TI2V 5B (video)",
        family: "wan2.2",
        license: "apache-2.0",
        license_url: APACHE_2,
        tasks: &[ModelTask::TextToVideo],
        min_memory_mb: 12_288,
        defaults: GenerationDefaults {
            width: 832,
            height: 480,
            steps: 20,
            cfg_scale: 6.0,
            sampler: "euler",
        },
        quants: &[
            CatalogQuant {
                id: "q3_k_m",
                label: "Q3_K_M",
                note: "The smallest download. Softer detail; for computers short on memory.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "QuantStack/Wan2.2-TI2V-5B-GGUF",
                    revision: "57437632ddd08bdcbd1508c866aa22e126ed51d2",
                    file: "Wan2.2-TI2V-5B-Q3_K_M.gguf",
                    sha256: "93cab80a36db70e9f2152915870d6cb9bdc7fdbf61811153222b5251b92839e6",
                    size: 2_547_790_176,
                },
            },
            CatalogQuant {
                id: "q4_0",
                label: "Q4_0",
                note: "Small and quick to load. Slightly softer detail.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "QuantStack/Wan2.2-TI2V-5B-GGUF",
                    revision: "57437632ddd08bdcbd1508c866aa22e126ed51d2",
                    file: "Wan2.2-TI2V-5B-Q4_0.gguf",
                    sha256: "fcf40dd62cb5e15556eef5f975700ab0b071aacd1939607689276e88f81ba463",
                    size: 3_029_086_560,
                },
            },
            CatalogQuant {
                id: "q4_k_m",
                label: "Q4_K_M",
                note: "Small, with more detail than Q4_0 for its size.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "QuantStack/Wan2.2-TI2V-5B-GGUF",
                    revision: "57437632ddd08bdcbd1508c866aa22e126ed51d2",
                    file: "Wan2.2-TI2V-5B-Q4_K_M.gguf",
                    sha256: "95b19697b7f98e65b0a543640e9ca7b4dfec32e2a6e3731e8e10708be52655e2",
                    size: 3_433_116_000,
                },
            },
            CatalogQuant {
                id: "q5_k_m",
                label: "Q5_K_M",
                note: "A balance of size and detail.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "QuantStack/Wan2.2-TI2V-5B-GGUF",
                    revision: "57437632ddd08bdcbd1508c866aa22e126ed51d2",
                    file: "Wan2.2-TI2V-5B-Q5_K_M.gguf",
                    sha256: "4424633a876511b9be58a41119f7c9d762ea92b3cb74649cdb43cac850e42dba",
                    size: 3_810_603_360,
                },
            },
            CatalogQuant {
                id: "q6_k",
                label: "Q6_K",
                note: "Close to full detail.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "QuantStack/Wan2.2-TI2V-5B-GGUF",
                    revision: "57437632ddd08bdcbd1508c866aa22e126ed51d2",
                    file: "Wan2.2-TI2V-5B-Q6_K.gguf",
                    sha256: "355f6bee35c4c6cbd0f275112619fe8ac6f7b9b067b885723667b3bde29497c3",
                    size: 4_211_683_680,
                },
            },
            CatalogQuant {
                id: "q8_0",
                label: "Q8_0",
                note: "Near full quality.",
                file: CatalogFile {
                    role: ModelFileRole::DiffusionModel,
                    repo: "QuantStack/Wan2.2-TI2V-5B-GGUF",
                    revision: "57437632ddd08bdcbd1508c866aa22e126ed51d2",
                    file: "Wan2.2-TI2V-5B-Q8_0.gguf",
                    sha256: "57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f",
                    size: 5_400_179_040,
                },
            },
        ],
        default_quant: "q4_0",
        files: &[
            CatalogFile {
                role: ModelFileRole::Vae,
                repo: "Comfy-Org/Wan_2.2_ComfyUI_Repackaged",
                revision: "c4f60d30c55a624e35427060fdd217579a6c1d77",
                file: "split_files/vae/wan2.2_vae.safetensors",
                sha256: "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156",
                size: 1_409_400_960,
            },
            CatalogFile {
                role: ModelFileRole::T5xxl,
                repo: "city96/umt5-xxl-encoder-gguf",
                revision: "b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7",
                file: "umt5-xxl-encoder-Q4_K_M.gguf",
                sha256: "17cf97a5bbbc60a646d6105b832b6f657ce904a8a1ad970e4b59df0c67584a40",
                size: 3_655_145_312,
            },
        ],
    },
];

/// Every model in the catalog.
pub fn catalog() -> &'static [CatalogModel] {
    &CATALOG
}

pub fn find_model(id: &str) -> Option<&'static CatalogModel> {
    CATALOG.iter().find(|model| model.id == id)
}

/// The model and size an id names: `sd-1.5` is its default size, and
/// `sd-1.5@q4_0` its Q4_0 size.
pub fn resolve_model(id: &str) -> Option<(&'static CatalogModel, &'static CatalogQuant)> {
    match id.split_once(QUANT_SEPARATOR) {
        Some((model_id, quant_id)) => {
            let model = find_model(model_id)?;
            Some((model, model.quant(quant_id)?))
        }
        None => find_model(id).map(|model| (model, model.standard_quant())),
    }
}

/// One file to download for a model, as the download manager takes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelDownload {
    pub url: String,
    pub save_path: String,
    pub sha256: &'static str,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelInstallPlan {
    pub id: &'static str,
    pub quant: &'static str,
    pub downloads: Vec<ModelDownload>,
    pub total_size: u64,
    pub installed: bool,
}

/// What to download for one size of a model under `data_dir`, and whether it
/// is already complete there.
pub fn model_install_plan(
    data_dir: &Path,
    model: &CatalogModel,
    quant: &CatalogQuant,
) -> ModelInstallPlan {
    let downloads: Vec<ModelDownload> = model
        .files_for(quant)
        .into_iter()
        .map(|file| ModelDownload {
            url: file.url(),
            // Every part of a model sits in the model's own folder, so the
            // parts its sizes share are downloaded once.
            save_path: format!("{MODELS_DIR}/{}/{}", model.id, file.file_name()),
            sha256: file.sha256,
            size: file.size,
        })
        .collect();
    let total_size = downloads.iter().map(|download| download.size).sum();
    // Complete means every part is there at its full size; the checksum was
    // checked by the download manager before the file was kept.
    let installed = downloads.iter().all(|download| {
        std::fs::metadata(data_dir.join(&download.save_path))
            .is_ok_and(|meta| meta.is_file() && meta.len() == download.size)
    });
    ModelInstallPlan {
        id: model.id,
        quant: quant.id,
        downloads,
        total_size,
        installed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_hex(value: &str, len: usize) -> bool {
        value.len() == len
            && value
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    }

    fn assert_pinned(model: &CatalogModel, file: &CatalogFile) {
        assert!(
            is_hex(file.revision, 40),
            "{} {} is not pinned to a commit",
            model.id,
            file.file
        );
        assert!(
            is_hex(file.sha256, 64),
            "{} {} has no SHA-256",
            model.id,
            file.file
        );
        assert!(file.size > 0, "{} {}", model.id, file.file);
        assert_eq!(
            file.url(),
            format!(
                "https://huggingface.co/{}/resolve/{}/{}",
                file.repo, file.revision, file.file
            )
        );
    }

    /// A tiny made-up model in two sizes, so tests never write gigabytes.
    const TINY_QUANTS: [CatalogQuant; 2] = [
        CatalogQuant {
            id: "q4_0",
            label: "Q4_0",
            note: "Small.",
            file: CatalogFile {
                role: ModelFileRole::DiffusionModel,
                repo: "example/tiny-model",
                revision: "0123456789abcdef0123456789abcdef01234567",
                file: "tiny-Q4_0.gguf",
                sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                size: 5,
            },
        },
        CatalogQuant {
            id: "q8_0",
            label: "Q8_0",
            note: "Near full quality.",
            file: CatalogFile {
                role: ModelFileRole::DiffusionModel,
                repo: "example/tiny-model",
                revision: "0123456789abcdef0123456789abcdef01234567",
                file: "tiny-Q8_0.gguf",
                sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                size: 9,
            },
        },
    ];

    const TINY_SHARED: [CatalogFile; 1] = [CatalogFile {
        role: ModelFileRole::Vae,
        repo: "example/tiny-parts",
        revision: "89abcdef0123456789abcdef0123456789abcdef",
        file: "split_files/vae/tiny_vae.safetensors",
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        size: 3,
    }];

    const TINY: CatalogModel = CatalogModel {
        id: "tiny",
        label: "Tiny",
        family: "test",
        license: "apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        tasks: &[ModelTask::TextToImage],
        min_memory_mb: 1,
        defaults: GenerationDefaults {
            width: 64,
            height: 64,
            steps: 1,
            cfg_scale: 1.0,
            sampler: "euler",
        },
        quants: &TINY_QUANTS,
        default_quant: "q4_0",
        files: &TINY_SHARED,
    };

    #[test]
    fn every_catalog_model_is_pinned_with_its_licence_sizes_and_checksums() {
        let models = catalog();
        assert!(!models.is_empty(), "the catalog is empty");
        let mut ids = std::collections::BTreeSet::new();
        for model in models {
            assert!(ids.insert(model.id), "duplicate id {}", model.id);
            assert!(
                model
                    .id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.'),
                "{} is not a plain id",
                model.id
            );
            assert!(
                !model.label.is_empty() && !model.license.is_empty(),
                "{}",
                model.id
            );
            assert!(model.license_url.starts_with("https://"), "{}", model.id);
            assert!(!model.tasks.is_empty(), "{}", model.id);
            assert!(model.min_memory_mb > 0, "{}", model.id);
            assert!(!model.quants.is_empty(), "{} offers no size", model.id);
            assert!(
                model.quant(model.default_quant).is_some(),
                "{} does not offer its default size",
                model.id
            );
            assert!(
                model
                    .quants
                    .windows(2)
                    .all(|pair| pair[0].file.size < pair[1].file.size),
                "{} sizes are not smallest first",
                model.id
            );
            let mut quant_ids = std::collections::BTreeSet::new();
            let main_role = model.quants[0].file.role;
            assert!(
                matches!(
                    main_role,
                    ModelFileRole::Model | ModelFileRole::DiffusionModel
                ),
                "{} main file has the wrong role",
                model.id
            );
            for quant in model.quants {
                assert!(
                    quant_ids.insert(quant.id),
                    "{} repeats {}",
                    model.id,
                    quant.id
                );
                assert!(
                    quant
                        .id
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                    "{} {} is not a plain id",
                    model.id,
                    quant.id
                );
                assert!(!quant.label.is_empty() && !quant.note.is_empty());
                assert_eq!(quant.file.role, main_role, "{} {}", model.id, quant.id);
                assert_pinned(model, &quant.file);
            }
            for file in model.files {
                assert!(
                    !matches!(
                        file.role,
                        ModelFileRole::Model | ModelFileRole::DiffusionModel
                    ),
                    "{} shares a main model file",
                    model.id
                );
                assert_pinned(model, file);
            }
        }
    }

    #[test]
    fn stable_diffusion_1_5_is_the_file_verified_on_this_pc() {
        let model = find_model("sd-1.5").expect("Stable Diffusion 1.5 is in the catalog");

        assert_eq!(model.tasks, [ModelTask::TextToImage]);
        assert_eq!(model.license, "creativeml-openrail-m");
        // Fits the laptop's shared graphics memory; 1.68 GB of weights on the GPU.
        assert!(model.min_memory_mb <= 4096);
        assert_eq!(model.defaults.width, 512);
        assert_eq!(model.defaults.height, 512);
        assert_eq!(model.defaults.steps, 20);
        assert!(model.files.is_empty());
        assert_eq!(
            model.standard_quant().file,
            CatalogFile {
                role: ModelFileRole::Model,
                repo: "second-state/stable-diffusion-v1-5-GGUF",
                revision: "031b5f5df991f511b3f5fa8fed6d99048ababb69",
                file: "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf",
                sha256: "d0555243938c62faeefb4ac93f6c7a053ad373a4290c5256bce229aeb193bf94",
                size: 1_763_578_176,
            }
        );
        assert!(find_model("not-a-model").is_none());
    }

    #[test]
    fn an_id_names_a_model_and_optionally_one_of_its_sizes() {
        let (model, quant) = resolve_model("sd-1.5").unwrap();
        assert_eq!((model.id, quant.id), ("sd-1.5", "q8_0"));

        let (model, quant) = resolve_model("sd-1.5@q4_0").unwrap();
        assert_eq!(model.id, "sd-1.5");
        assert_eq!(
            quant.file.file,
            "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf"
        );

        assert!(resolve_model("sd-1.5@q9_9").is_none());
        assert!(resolve_model("not-a-model@q4_0").is_none());
        assert!(resolve_model("not-a-model").is_none());
    }

    #[test]
    fn each_file_is_saved_in_its_models_own_folder() {
        let data = tempfile::TempDir::new().unwrap();

        let plan = model_install_plan(data.path(), &TINY, &TINY_QUANTS[0]);

        assert_eq!((plan.id, plan.quant), ("tiny", "q4_0"));
        assert_eq!(plan.total_size, 8);
        assert_eq!(
            plan.downloads,
            [
                ModelDownload {
                    url: "https://huggingface.co/example/tiny-model/resolve/0123456789abcdef0123456789abcdef01234567/tiny-Q4_0.gguf".to_string(),
                    save_path: "media/models/tiny/tiny-Q4_0.gguf".to_string(),
                    sha256: TINY_QUANTS[0].file.sha256,
                    size: 5,
                },
                ModelDownload {
                    // Folders inside the repository are not kept: every part sits in one folder.
                    url: "https://huggingface.co/example/tiny-parts/resolve/89abcdef0123456789abcdef0123456789abcdef/split_files/vae/tiny_vae.safetensors".to_string(),
                    save_path: "media/models/tiny/tiny_vae.safetensors".to_string(),
                    sha256: TINY_SHARED[0].sha256,
                    size: 3,
                },
            ]
        );
        assert!(!plan.installed);
    }

    #[test]
    fn a_model_counts_as_installed_only_when_every_file_is_complete() {
        let data = tempfile::TempDir::new().unwrap();
        let folder = data.path().join("media/models/tiny");
        std::fs::create_dir_all(&folder).unwrap();
        let small = &TINY_QUANTS[0];

        std::fs::write(folder.join("tiny-Q4_0.gguf"), b"12345").unwrap();
        assert!(
            !model_install_plan(data.path(), &TINY, small).installed,
            "one part is missing"
        );

        std::fs::write(folder.join("tiny_vae.safetensors"), b"12").unwrap();
        assert!(
            !model_install_plan(data.path(), &TINY, small).installed,
            "one part is cut short"
        );

        std::fs::write(folder.join("tiny_vae.safetensors"), b"123").unwrap();
        assert!(model_install_plan(data.path(), &TINY, small).installed);
    }

    #[test]
    fn another_size_needs_only_its_own_main_file() {
        let data = tempfile::TempDir::new().unwrap();
        let folder = data.path().join("media/models/tiny");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("tiny-Q4_0.gguf"), b"12345").unwrap();
        std::fs::write(folder.join("tiny_vae.safetensors"), b"123").unwrap();

        let larger = model_install_plan(data.path(), &TINY, &TINY_QUANTS[1]);

        assert!(!larger.installed, "its own main file is not there yet");
        let missing: Vec<&str> = larger
            .downloads
            .iter()
            .filter(|download| {
                std::fs::metadata(data.path().join(&download.save_path))
                    .map(|meta| meta.len() != download.size)
                    .unwrap_or(true)
            })
            .map(|download| download.save_path.as_str())
            .collect();
        assert_eq!(missing, ["media/models/tiny/tiny-Q8_0.gguf"]);

        std::fs::write(folder.join("tiny-Q8_0.gguf"), b"123456789").unwrap();
        assert!(model_install_plan(data.path(), &TINY, &TINY_QUANTS[1]).installed);
        assert!(
            model_install_plan(data.path(), &TINY, &TINY_QUANTS[0]).installed,
            "the smaller size is still there"
        );
    }
}
