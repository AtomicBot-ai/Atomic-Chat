//! Decides which GPU a runtime instance runs on and keeps count of the video
//! memory every instance Radium placed has claimed.
//!
//! Two 24 GB cards are not one 48 GB card. A model either fits one card, or it
//! is split across both - by layers (more room, not more speed) or by tensor
//! parallelism (needs a runtime that supports it). The ledger refuses a
//! placement that would overfill a card and says which profile would fit.
//!
//! GPUs are identified by UUID, never by index: CUDA's device order can differ
//! from the order other tools report.

use serde::Serialize;

/// Memory in MiB, the unit the hardware plugin reports.
pub type Mib = u64;

/// Headroom left free on every card for the driver, the desktop and CUDA
/// context overhead.
pub const HEADROOM_MIB: Mib = 768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Gpu {
    /// The hardware plugin's UUID (without NVIDIA's `GPU-` prefix).
    pub uuid: String,
    pub name: String,
    pub total_mib: Mib,
    /// Memory in use right now as measured by the driver, when known. It covers
    /// programs Radium did not start, so it is the floor for what is used.
    pub measured_used_mib: Option<Mib>,
}

/// How the caller wants an instance spread over the GPUs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "profile")]
pub enum Profile {
    /// One card if the model fits on one, otherwise a layer split.
    Auto,
    /// This card only.
    Pinned { uuid: String },
    /// Layers across every card, in proportion to free memory.
    SplitLayer,
    /// Tensor parallelism across every card: an equal share on each.
    SplitTensor,
}

/// Where an instance's memory goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Placement {
    pub profile: Profile,
    /// (GPU UUID, MiB claimed on it), in the order the runtime should see them.
    pub shares: Vec<(String, Mib)>,
}

impl Placement {
    pub fn uuids(&self) -> Vec<&str> {
        self.shares.iter().map(|(uuid, _)| uuid.as_str()).collect()
    }

    /// `CUDA_VISIBLE_DEVICES` for this placement, by UUID.
    pub fn cuda_visible_devices(&self) -> String {
        self.shares
            .iter()
            .map(|(uuid, _)| {
                if uuid.starts_with("GPU-") {
                    uuid.clone()
                } else {
                    format!("GPU-{uuid}")
                }
            })
            .collect::<Vec<_>>()
            .join(",")
    }

    /// llama.cpp arguments for this placement. The devices are already
    /// narrowed by `CUDA_VISIBLE_DEVICES`, so the split ratios refer to the
    /// visible order.
    pub fn llama_cpp_args(&self) -> Vec<String> {
        match (&self.profile, self.shares.len()) {
            (_, 0 | 1) => vec!["--split-mode".into(), "none".into()],
            (Profile::SplitTensor, _) => vec!["--split-mode".into(), "tensor".into()],
            _ => {
                let ratios = self
                    .shares
                    .iter()
                    .map(|(_, mib)| mib.to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                vec![
                    "--split-mode".into(),
                    "layer".into(),
                    "--tensor-split".into(),
                    ratios,
                ]
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlacementError {
    pub message: String,
    /// A profile that would fit, when one would.
    pub suggestion: Option<Profile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reservation {
    pub instance_id: String,
    pub placement: Placement,
}

/// The GPUs and what every placed instance has claimed on them.
#[derive(Debug, Clone, Default, Serialize)]
pub struct GpuLedger {
    gpus: Vec<Gpu>,
    reservations: Vec<Reservation>,
}

impl GpuLedger {
    pub fn new(gpus: Vec<Gpu>) -> Self {
        Self {
            gpus,
            reservations: Vec::new(),
        }
    }

    pub fn gpus(&self) -> &[Gpu] {
        &self.gpus
    }

    pub fn reservations(&self) -> &[Reservation] {
        &self.reservations
    }

    /// Replaces the driver's measurements, keeping reservations.
    pub fn update_measurements(&mut self, used: &[(String, Mib)]) {
        for gpu in &mut self.gpus {
            if let Some((_, mib)) = used.iter().find(|(uuid, _)| *uuid == gpu.uuid) {
                gpu.measured_used_mib = Some(*mib);
            }
        }
    }

    fn reserved_on(&self, uuid: &str) -> Mib {
        self.reservations
            .iter()
            .flat_map(|r| r.placement.shares.iter())
            .filter(|(id, _)| id == uuid)
            .map(|(_, mib)| *mib)
            .sum()
    }

    /// What can still be claimed on a card: its size less headroom, less the
    /// larger of what Radium reserved and what the driver says is used.
    pub fn free_mib(&self, uuid: &str) -> Mib {
        let Some(gpu) = self.gpus.iter().find(|gpu| gpu.uuid == uuid) else {
            return 0;
        };
        let used = self
            .reserved_on(uuid)
            .max(gpu.measured_used_mib.unwrap_or(0));
        gpu.total_mib.saturating_sub(HEADROOM_MIB).saturating_sub(used)
    }

    /// Where an instance needing `need_mib` would go under `profile`.
    pub fn plan(&self, need_mib: Mib, profile: &Profile) -> Result<Placement, PlacementError> {
        if self.gpus.is_empty() {
            return Err(PlacementError {
                message: "No GPU is available".into(),
                suggestion: None,
            });
        }
        let best_single = self
            .gpus
            .iter()
            .map(|gpu| (gpu.uuid.clone(), self.free_mib(&gpu.uuid)))
            .max_by_key(|(_, free)| *free)
            .expect("at least one GPU");
        let total_free: Mib = self.gpus.iter().map(|gpu| self.free_mib(&gpu.uuid)).sum();
        let multi = self.gpus.len() > 1;

        match profile {
            Profile::Pinned { uuid } => {
                if !self.gpus.iter().any(|gpu| &gpu.uuid == uuid) {
                    return Err(PlacementError {
                        message: format!("GPU {uuid} is not present"),
                        suggestion: Some(Profile::Auto),
                    });
                }
                let free = self.free_mib(uuid);
                if need_mib <= free {
                    Ok(Placement {
                        profile: profile.clone(),
                        shares: vec![(uuid.clone(), need_mib)],
                    })
                } else {
                    Err(PlacementError {
                        message: format!(
                            "Needs {need_mib} MiB but GPU {uuid} has {free} MiB free"
                        ),
                        suggestion: if need_mib <= best_single.1 {
                            Some(Profile::Pinned {
                                uuid: best_single.0.clone(),
                            })
                        } else if multi && need_mib <= total_free {
                            Some(Profile::SplitLayer)
                        } else {
                            None
                        },
                    })
                }
            }
            Profile::Auto => {
                if need_mib <= best_single.1 {
                    Ok(Placement {
                        profile: Profile::Auto,
                        shares: vec![(best_single.0, need_mib)],
                    })
                } else if multi {
                    self.split_layer(need_mib, total_free, Profile::Auto)
                } else {
                    Err(too_big(need_mib, total_free))
                }
            }
            Profile::SplitLayer => self.split_layer(need_mib, total_free, Profile::SplitLayer),
            Profile::SplitTensor => {
                let count = self.gpus.len() as Mib;
                let each = need_mib.div_ceil(count);
                let short = self
                    .gpus
                    .iter()
                    .find(|gpu| self.free_mib(&gpu.uuid) < each);
                match short {
                    None => Ok(Placement {
                        profile: Profile::SplitTensor,
                        shares: self
                            .gpus
                            .iter()
                            .map(|gpu| (gpu.uuid.clone(), each))
                            .collect(),
                    }),
                    Some(gpu) => Err(PlacementError {
                        message: format!(
                            "Tensor parallelism needs {each} MiB on every GPU; {} has {} MiB free",
                            gpu.uuid,
                            self.free_mib(&gpu.uuid)
                        ),
                        suggestion: (need_mib <= total_free).then_some(Profile::SplitLayer),
                    }),
                }
            }
        }
    }

    fn split_layer(
        &self,
        need_mib: Mib,
        total_free: Mib,
        profile: Profile,
    ) -> Result<Placement, PlacementError> {
        if need_mib > total_free {
            return Err(too_big(need_mib, total_free));
        }
        // Each card's share is proportional to its free memory; the rounding
        // remainder goes to the card with the most room.
        let mut shares: Vec<(String, Mib)> = self
            .gpus
            .iter()
            .map(|gpu| {
                let free = self.free_mib(&gpu.uuid);
                (gpu.uuid.clone(), need_mib * free / total_free.max(1))
            })
            .collect();
        let assigned: Mib = shares.iter().map(|(_, mib)| *mib).sum();
        if let Some(largest) = shares
            .iter_mut()
            .max_by_key(|(uuid, _)| self.free_mib(uuid))
        {
            largest.1 += need_mib - assigned;
        }
        shares.retain(|(_, mib)| *mib > 0);
        Ok(Placement { profile, shares })
    }

    /// Records a planned placement for an instance.
    pub fn reserve(&mut self, instance_id: &str, placement: Placement) -> Result<(), String> {
        if self
            .reservations
            .iter()
            .any(|r| r.instance_id == instance_id)
        {
            return Err(format!("{instance_id} already holds GPU memory"));
        }
        for (uuid, mib) in &placement.shares {
            let free = self.free_mib(uuid);
            if *mib > free {
                return Err(format!(
                    "Needs {mib} MiB on GPU {uuid} but only {free} MiB is free"
                ));
            }
        }
        self.reservations.push(Reservation {
            instance_id: instance_id.to_string(),
            placement,
        });
        Ok(())
    }

    /// Gives back an instance's memory. Returns false if it held none.
    pub fn release(&mut self, instance_id: &str) -> bool {
        let before = self.reservations.len();
        self.reservations.retain(|r| r.instance_id != instance_id);
        self.reservations.len() != before
    }
}

fn too_big(need_mib: Mib, total_free: Mib) -> PlacementError {
    PlacementError {
        message: format!(
            "Needs {need_mib} MiB but only {total_free} MiB is free across all GPUs; \
             use a smaller quantization or shorter context, or offload layers to the CPU"
        ),
        suggestion: None,
    }
}

/// The KV cache of a transformer decoder, in MiB, for `context` tokens:
/// keys and values for every layer, KV head and head dimension.
pub fn kv_cache_mib(
    layers: u64,
    context: u64,
    kv_heads: u64,
    head_dim: u64,
    bytes_per_element: f64,
) -> Mib {
    let bytes = 2.0 * (layers * context * kv_heads * head_dim) as f64 * bytes_per_element;
    (bytes / (1024.0 * 1024.0)).ceil() as Mib
}

/// What an instance will claim: weights, KV cache and a compute buffer
/// allowance proportional to the weights (10%, at least 512 MiB).
pub fn estimate_mib(weights_mib: Mib, kv_mib: Mib) -> Mib {
    weights_mib + kv_mib + (weights_mib / 10).max(512)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaa-3090-0";
    const B: &str = "bbbb-3090-1";

    fn two_3090s() -> GpuLedger {
        GpuLedger::new(vec![
            Gpu {
                uuid: A.into(),
                name: "NVIDIA GeForce RTX 3090".into(),
                total_mib: 24576,
                measured_used_mib: None,
            },
            Gpu {
                uuid: B.into(),
                name: "NVIDIA GeForce RTX 3090".into(),
                total_mib: 24576,
                measured_used_mib: None,
            },
        ])
    }

    const PER_CARD: Mib = 24576 - HEADROOM_MIB;

    #[test]
    fn a_model_that_fits_one_card_goes_on_one_card() {
        let ledger = two_3090s();
        let placement = ledger.plan(10_000, &Profile::Auto).unwrap();
        assert_eq!(placement.shares.len(), 1);
        assert_eq!(placement.llama_cpp_args(), ["--split-mode", "none"]);
    }

    #[test]
    fn a_model_too_big_for_one_card_is_split_by_layers() {
        let ledger = two_3090s();
        let placement = ledger.plan(40_000, &Profile::Auto).unwrap();
        assert_eq!(placement.shares.len(), 2);
        let total: Mib = placement.shares.iter().map(|(_, mib)| mib).sum();
        assert_eq!(total, 40_000);
        assert_eq!(placement.llama_cpp_args()[..3], ["--split-mode", "layer", "--tensor-split"]);
    }

    #[test]
    fn two_cards_are_not_one_48_gb_card() {
        let ledger = two_3090s();
        let error = ledger.plan(2 * PER_CARD + 1, &Profile::Auto).unwrap_err();
        assert!(error.message.contains("across all GPUs"), "{}", error.message);
        assert_eq!(error.suggestion, None);
    }

    #[test]
    fn the_second_model_lands_on_the_emptier_card() {
        let mut ledger = two_3090s();
        let first = ledger.plan(18_000, &Profile::Auto).unwrap();
        let first_gpu = first.shares[0].0.clone();
        ledger.reserve("chat", first).unwrap();

        let second = ledger.plan(12_000, &Profile::Auto).unwrap();
        assert_ne!(second.shares[0].0, first_gpu);
    }

    #[test]
    fn a_pinned_card_that_is_full_suggests_the_other_card() {
        let mut ledger = two_3090s();
        ledger
            .reserve(
                "comfyui",
                Placement {
                    profile: Profile::Pinned { uuid: B.into() },
                    shares: vec![(B.into(), 20_000)],
                },
            )
            .unwrap();
        let error = ledger
            .plan(10_000, &Profile::Pinned { uuid: B.into() })
            .unwrap_err();
        assert_eq!(error.suggestion, Some(Profile::Pinned { uuid: A.into() }));
    }

    #[test]
    fn tensor_parallelism_needs_an_equal_share_on_every_card() {
        let mut ledger = two_3090s();
        let placement = ledger.plan(30_000, &Profile::SplitTensor).unwrap();
        assert_eq!(placement.shares, vec![(A.into(), 15_000), (B.into(), 15_000)]);
        assert_eq!(placement.llama_cpp_args(), ["--split-mode", "tensor"]);

        ledger
            .reserve(
                "whisper",
                Placement {
                    profile: Profile::Pinned { uuid: B.into() },
                    shares: vec![(B.into(), 12_000)],
                },
            )
            .unwrap();
        let error = ledger.plan(30_000, &Profile::SplitTensor).unwrap_err();
        assert_eq!(error.suggestion, Some(Profile::SplitLayer));
    }

    #[test]
    fn memory_used_by_other_programs_counts_against_the_card() {
        let mut ledger = two_3090s();
        ledger.update_measurements(&[(A.into(), 20_000)]);
        assert_eq!(ledger.free_mib(A), PER_CARD - 20_000);
        assert_eq!(ledger.free_mib(B), PER_CARD);
        let placement = ledger.plan(8_000, &Profile::Auto).unwrap();
        assert_eq!(placement.shares[0].0, B);
    }

    #[test]
    fn reserving_more_than_is_free_is_refused_and_release_gives_it_back() {
        let mut ledger = two_3090s();
        let big = Placement {
            profile: Profile::Pinned { uuid: A.into() },
            shares: vec![(A.into(), PER_CARD)],
        };
        ledger.reserve("one", big.clone()).unwrap();
        assert!(ledger.reserve("two", big.clone()).is_err());
        assert!(ledger.reserve("one", big.clone()).is_err(), "same id twice");
        assert!(ledger.release("one"));
        assert!(!ledger.release("one"));
        ledger.reserve("two", big).unwrap();
    }

    #[test]
    fn cuda_devices_are_named_by_uuid_with_the_gpu_prefix() {
        let placement = Placement {
            profile: Profile::SplitLayer,
            shares: vec![(A.into(), 1), ("GPU-already".into(), 1)],
        };
        assert_eq!(
            placement.cuda_visible_devices(),
            format!("GPU-{A},GPU-already")
        );
    }

    #[test]
    fn no_gpu_means_no_placement() {
        let ledger = GpuLedger::new(vec![]);
        assert!(ledger.plan(1, &Profile::Auto).is_err());
    }

    #[test]
    fn kv_cache_of_an_8b_llama_at_8k_context_in_f16_is_1_gib() {
        // Llama 3 8B: 32 layers, 8 KV heads, head dim 128.
        assert_eq!(kv_cache_mib(32, 8192, 8, 128, 2.0), 1024);
        // q8_0 KV cache is about half.
        assert!(kv_cache_mib(32, 8192, 8, 128, 1.0625) < 600);
    }

    #[test]
    fn estimates_add_a_compute_allowance() {
        assert_eq!(estimate_mib(4_000, 1_024), 4_000 + 1_024 + 512);
        assert_eq!(estimate_mib(40_000, 0), 44_000);
    }
}
