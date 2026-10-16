//! Resolution rules for the built-in engine's models: the one place sizes,
//! aspect-ratio presets, output (upscale) targets, frame counts and rough
//! memory estimates are worked out.
//!
//! Every model in the catalog carries a [`ResolutionRules`]; the Media page
//! receives the rules *and* the presets computed from them through
//! `media_engine_status`, so the web app holds no size tables of its own.
//!
//! Sizes are computed at the model's recommended pixel budget for each aspect
//! ratio and snapped to the size multiple the model's latent space needs
//! (64 for Stable Diffusion 1.x/XL, 16 for FLUX, 32 for Wan 2.2 5B).

use serde::Serialize;

/// How a model family wants its sizes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ResolutionRules {
    /// The size the model was trained at, landscape-or-square first.
    pub native: [u32; 2],
    /// Width and height must both be a multiple of this.
    pub multiple: u32,
    /// Smallest and largest side the engine is allowed to render.
    pub min_side: u32,
    pub max_side: u32,
    /// Pixels (width × height) the presets aim for: the model's sweet spot.
    pub pixel_budget: u32,
    /// Outside this pixel range the model still runs but quality or speed
    /// suffers (doubled subjects above, mush below), so the UI warns.
    pub comfortable_min_pixels: u32,
    pub comfortable_max_pixels: u32,
    /// Rough working memory per megapixel rendered, on top of the weights.
    /// For video this is per latent frame (Wan packs 4 frames into one).
    pub vram_mb_per_megapixel: u32,
    /// Sizes offered on top of the aspect presets, e.g. Wan's faster 832×480.
    pub extra_sizes: &'static [[u32; 2]],
}

/// Aspect ratios offered for every model, as `(width, height)` parts.
pub const ASPECT_RATIOS: [(u32, u32); 11] = [
    (1, 1),
    (4, 3),
    (3, 4),
    (3, 2),
    (2, 3),
    (16, 9),
    (9, 16),
    (21, 9),
    (9, 21),
    (5, 4),
    (4, 5),
];

/// Why a preset is offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PresetKind {
    /// The model's trained size.
    Native,
    /// An aspect ratio at the model's pixel budget.
    Aspect,
    /// A smaller size kept as a faster option.
    Fast,
}

/// One size the resolution picker offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SizePreset {
    /// The aspect ratio it was made for, `16:9`, or the reduced ratio of an
    /// extra size.
    pub aspect: String,
    pub width: u32,
    pub height: u32,
    pub kind: PresetKind,
    /// What the picker shows: `16:9 · 1344 × 768`.
    pub label: String,
}

/// Rounds `value` to the nearest multiple of `multiple` (half away from zero).
pub fn snap(value: f64, multiple: u32) -> u32 {
    let multiple = multiple.max(1) as f64;
    ((value / multiple).round() * multiple).max(multiple) as u32
}

/// Clamps a side to the model's limits, then snaps it; the limits are
/// themselves snapped inwards so the result always stays inside them.
fn snap_side(value: f64, rules: &ResolutionRules) -> u32 {
    let m = rules.multiple.max(1);
    let lo = rules.min_side.div_ceil(m) * m;
    let hi = (rules.max_side / m) * m;
    snap(value, m).clamp(lo, hi.max(lo))
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// The reduced ratio of a size, `1280×704` → `20:11`.
pub fn aspect_label(width: u32, height: u32) -> String {
    let divisor = gcd(width, height).max(1);
    format!("{}:{}", width / divisor, height / divisor)
}

/// The size for an aspect ratio at the model's pixel budget, snapped.
/// When the ideal long side is beyond `max_side`, the long side is pinned at
/// the maximum and the short side follows the ratio.
pub fn size_for_aspect(rules: &ResolutionRules, aw: u32, ah: u32) -> [u32; 2] {
    let ratio = aw as f64 / ah as f64;
    let budget = rules.pixel_budget as f64;
    let mut width = (budget * ratio).sqrt();
    let mut height = budget / width;
    let max = rules.max_side as f64;
    if width > max {
        width = max;
        height = max / ratio;
    }
    if height > max {
        height = max;
        width = max * ratio;
    }
    [snap_side(width, rules), snap_side(height, rules)]
}

/// Every size the picker offers for a model: its native size first, then one
/// per aspect ratio at its budget, then the faster extra sizes. No size
/// appears twice.
pub fn presets(rules: &ResolutionRules) -> Vec<SizePreset> {
    let mut out: Vec<SizePreset> = Vec::new();
    let mut push = |width: u32, height: u32, aspect: String, kind: PresetKind| {
        if out.iter().any(|p| p.width == width && p.height == height) {
            return;
        }
        let label = match kind {
            PresetKind::Native => format!("{aspect} · {width} × {height} (native)"),
            PresetKind::Aspect => format!("{aspect} · {width} × {height}"),
            PresetKind::Fast => format!("{aspect} · {width} × {height} (faster)"),
        };
        out.push(SizePreset {
            aspect,
            width,
            height,
            kind,
            label,
        });
    };
    let [nw, nh] = rules.native;
    push(nw, nh, nearest_aspect(nw, nh), PresetKind::Native);
    for (aw, ah) in ASPECT_RATIOS {
        let [w, h] = size_for_aspect(rules, aw, ah);
        push(w, h, format!("{aw}:{ah}"), PresetKind::Aspect);
    }
    for &[w, h] in rules.extra_sizes {
        push(w, h, nearest_aspect(w, h), PresetKind::Fast);
    }
    out
}

/// The named aspect ratio closest to a size (`1280×704` is `16:9`), or its
/// reduced ratio when none is within 3%.
pub fn nearest_aspect(width: u32, height: u32) -> String {
    let ratio = width as f64 / height as f64;
    ASPECT_RATIOS
        .iter()
        .map(|&(aw, ah)| (aw, ah, ((aw as f64 / ah as f64) / ratio - 1.0).abs()))
        .filter(|&(_, _, error)| error < 0.03)
        .min_by(|a, b| a.2.total_cmp(&b.2))
        .map(|(aw, ah, _)| format!("{aw}:{ah}"))
        .unwrap_or_else(|| aspect_label(width, height))
}

/// A custom size, checked and snapped to what the model can render.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SizeCheck {
    pub width: u32,
    pub height: u32,
    /// The size had to change to fit the model's multiple or limits.
    pub adjusted: bool,
    /// Plain-words warnings, empty when the size is comfortable.
    pub warnings: Vec<String>,
}

/// Snaps a requested size to the model's multiple and limits and says when
/// the result is outside the range the model is comfortable with.
pub fn check_size(rules: &ResolutionRules, width: u32, height: u32) -> SizeCheck {
    let w = snap_side(width as f64, rules);
    let h = snap_side(height as f64, rules);
    let adjusted = w != width || h != height;
    let mut warnings = Vec::new();
    if adjusted {
        warnings.push(format!(
            "Adjusted to {w} × {h}: sides must be multiples of {} between {} and {}.",
            rules.multiple, rules.min_side, rules.max_side
        ));
    }
    let pixels = w as u64 * h as u64;
    if pixels > rules.comfortable_max_pixels as u64 {
        warnings.push(
            "Larger than this model is comfortable with: expect repeated subjects, \
             slow renders and high memory use. Render smaller and upscale instead."
                .to_string(),
        );
    } else if pixels < rules.comfortable_min_pixels as u64 {
        warnings.push(
            "Smaller than this model is comfortable with: expect soft, muddled detail.".to_string(),
        );
    }
    SizeCheck {
        width: w,
        height: h,
        adjusted,
        warnings,
    }
}

/// Frames for a clip of `seconds` at `fps`, on the lattice
/// `n % modulus == offset` the model wants (Wan: 4n + 1), never fewer than
/// `modulus + offset`.
pub fn frames_for(seconds: f64, fps: u32, modulus: u32, offset: u32) -> u32 {
    let modulus = modulus.max(1);
    let k = ((seconds * fps as f64 - offset as f64) / modulus as f64).round();
    let k = if k.is_finite() {
        (k as i64).max(1) as u32
    } else {
        1
    };
    modulus * k + offset
}

/// A rough estimate of graphics memory for one render: the model's weights
/// (`base_mb`) plus working memory for the pixels, and for video the latent
/// frames (Wan packs 4 frames into one latent frame).
pub fn estimate_vram_mb(
    rules: &ResolutionRules,
    base_mb: u64,
    width: u32,
    height: u32,
    frames: Option<u32>,
) -> u64 {
    let megapixels = width as f64 * height as f64 / 1_000_000.0;
    let latent_frames = frames
        .map(|n| (n.saturating_sub(1) / 4 + 1) as f64)
        .unwrap_or(1.0);
    // Activations do not grow fully linearly with frames thanks to offload and
    // attention chunking; a square-root term keeps long clips plausible.
    let frame_factor = if frames.is_some() {
        latent_frames.sqrt()
    } else {
        1.0
    };
    base_mb + (rules.vram_mb_per_megapixel as f64 * megapixels * frame_factor).round() as u64
}

/// One "output size" choice: the finished image is upscaled to this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OutputSize {
    pub id: &'static str,
    pub label: &'static str,
    /// Long side of the finished image in pixels; 0 keeps the rendered size.
    pub long_edge: u32,
}

/// Output sizes for images. 4K is 3840 on the long side: 3840 × 2160 at 16:9,
/// 2880 × 3840 at 3:4 and so on.
pub const OUTPUT_SIZES: [OutputSize; 4] = [
    OutputSize {
        id: "native",
        label: "As rendered",
        long_edge: 0,
    },
    OutputSize {
        id: "fhd",
        label: "Full HD (1920 long side)",
        long_edge: 1920,
    },
    OutputSize {
        id: "qhd",
        label: "2K (2560 long side)",
        long_edge: 2560,
    },
    OutputSize {
        id: "4k",
        label: "4K (3840 long side · 3840 × 2160 at 16:9)",
        long_edge: 3840,
    },
];

pub fn find_output_size(id: &str) -> Option<&'static OutputSize> {
    OUTPUT_SIZES.iter().find(|size| size.id == id)
}

/// The finished size for an image of `width × height` with its long side at
/// `long_edge`, keeping the aspect ratio; both sides even.
pub fn output_target(width: u32, height: u32, long_edge: u32) -> [u32; 2] {
    if long_edge == 0 || width == 0 || height == 0 {
        return [width, height];
    }
    let even = |value: f64| ((value / 2.0).round() as u32 * 2).max(2);
    if width >= height {
        [
            long_edge,
            even(long_edge as f64 * height as f64 / width as f64),
        ]
    } else {
        [
            even(long_edge as f64 * width as f64 / height as f64),
            long_edge,
        ]
    }
}

/// How many 4× ESRGAN passes reach `target` from `source` (0 when the source
/// is already big enough, at most 2).
pub fn esrgan_passes(source: [u32; 2], target: [u32; 2]) -> u32 {
    let mut size = source;
    let mut passes = 0;
    while (size[0] < target[0] || size[1] < target[1]) && passes < 2 {
        size = [size[0] * 4, size[1] * 4];
        passes += 1;
    }
    passes
}

pub const SD1_RULES: ResolutionRules = ResolutionRules {
    native: [512, 512],
    multiple: 64,
    min_side: 256,
    max_side: 1024,
    pixel_budget: 512 * 512,
    comfortable_min_pixels: 384 * 384,
    comfortable_max_pixels: 768 * 768,
    vram_mb_per_megapixel: 2_400,
    extra_sizes: &[],
};

pub const SDXL_RULES: ResolutionRules = ResolutionRules {
    native: [1024, 1024],
    multiple: 64,
    min_side: 512,
    max_side: 2048,
    pixel_budget: 1024 * 1024,
    comfortable_min_pixels: 768 * 768,
    comfortable_max_pixels: 1280 * 1280,
    vram_mb_per_megapixel: 1_800,
    extra_sizes: &[],
};

pub const FLUX_RULES: ResolutionRules = ResolutionRules {
    native: [1024, 1024],
    multiple: 16,
    min_side: 256,
    max_side: 2048,
    pixel_budget: 1024 * 1024,
    comfortable_min_pixels: 512 * 512,
    comfortable_max_pixels: 1536 * 1536,
    vram_mb_per_megapixel: 2_600,
    extra_sizes: &[],
};

/// Wan 2.2 TI2V 5B was trained at 1280 × 704 (and 704 × 1280); its VAE
/// compresses 16× and the transformer patches 2×, so sides are multiples of 32.
pub const WAN22_5B_RULES: ResolutionRules = ResolutionRules {
    native: [1280, 704],
    multiple: 32,
    min_side: 256,
    max_side: 1280,
    pixel_budget: 1280 * 704,
    comfortable_min_pixels: 640 * 352,
    comfortable_max_pixels: 1280 * 720,
    vram_mb_per_megapixel: 1_500,
    extra_sizes: &[[832, 480], [480, 832], [640, 352], [352, 640]],
};

#[cfg(test)]
mod tests {
    use super::*;

    fn all_rules() -> [(&'static str, ResolutionRules); 4] {
        [
            ("sd1", SD1_RULES),
            ("sdxl", SDXL_RULES),
            ("flux", FLUX_RULES),
            ("wan", WAN22_5B_RULES),
        ]
    }

    #[test]
    fn snap_rounds_to_the_nearest_multiple_and_never_to_zero() {
        assert_eq!(snap(1000.0, 64), 1024);
        assert_eq!(snap(1010.0, 64), 1024);
        assert_eq!(snap(980.0, 64), 960);
        assert_eq!(snap(712.0, 32), 704);
        assert_eq!(snap(3.0, 16), 16);
    }

    #[test]
    fn every_preset_is_on_the_models_multiple_and_inside_its_limits() {
        for (name, rules) in all_rules() {
            for preset in presets(&rules) {
                for side in [preset.width, preset.height] {
                    assert_eq!(side % rules.multiple, 0, "{name} {preset:?}");
                    assert!(
                        side >= rules.min_side && side <= rules.max_side,
                        "{name} {preset:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn presets_start_native_have_no_duplicates_and_cover_every_aspect() {
        for (name, rules) in all_rules() {
            let list = presets(&rules);
            assert_eq!([list[0].width, list[0].height], rules.native, "{name}");
            assert_eq!(list[0].kind, PresetKind::Native);
            for (i, a) in list.iter().enumerate() {
                for b in &list[i + 1..] {
                    assert!(
                        !(a.width == b.width && a.height == b.height),
                        "{name} repeats {a:?}"
                    );
                }
            }
            // Every aspect is offered, either as its own preset or as the native size.
            for (aw, ah) in ASPECT_RATIOS {
                let [w, h] = size_for_aspect(&rules, aw, ah);
                assert!(
                    list.iter().any(|p| p.width == w && p.height == h),
                    "{name} {aw}:{ah}"
                );
            }
        }
    }

    #[test]
    fn aspect_presets_stay_near_the_pixel_budget_and_ratio() {
        for (name, rules) in all_rules() {
            for (aw, ah) in [(1, 1), (4, 3), (3, 2), (16, 9), (2, 3)] {
                let [w, h] = size_for_aspect(&rules, aw, ah);
                let pixels = (w * h) as f64;
                let budget = rules.pixel_budget as f64;
                assert!(
                    (pixels / budget - 1.0).abs() < 0.2,
                    "{name} {aw}:{ah} {w}x{h}"
                );
                let ratio_error = ((w as f64 / h as f64) / (aw as f64 / ah as f64) - 1.0).abs();
                assert!(ratio_error < 0.1, "{name} {aw}:{ah} {w}x{h}");
            }
        }
    }

    #[test]
    fn known_sizes_come_out_as_the_community_expects() {
        assert_eq!(size_for_aspect(&SDXL_RULES, 1, 1), [1024, 1024]);
        assert_eq!(size_for_aspect(&SDXL_RULES, 16, 9), [1344, 768]);
        assert_eq!(size_for_aspect(&SDXL_RULES, 2, 3), [832, 1280]);
        assert_eq!(size_for_aspect(&SD1_RULES, 2, 3), [448, 640]);
        assert_eq!(size_for_aspect(&FLUX_RULES, 16, 9), [1360, 768]);
        // Wan 2.2 5B lands on its trained sizes.
        assert_eq!(size_for_aspect(&WAN22_5B_RULES, 16, 9), [1280, 704]);
        assert_eq!(size_for_aspect(&WAN22_5B_RULES, 9, 16), [704, 1280]);
    }

    #[test]
    fn a_ratio_too_wide_for_the_budget_pins_the_long_side() {
        let [w, h] = size_for_aspect(&WAN22_5B_RULES, 21, 9);
        assert_eq!(w, 1280);
        assert_eq!(h, 544);
    }

    #[test]
    fn wan_offers_native_portrait_and_the_old_faster_sizes() {
        let list = presets(&WAN22_5B_RULES);
        assert_eq!((list[0].width, list[0].height), (1280, 704));
        assert_eq!(list[0].aspect, "16:9");
        assert!(list.iter().any(|p| (p.width, p.height) == (704, 1280)));
        let fast = list
            .iter()
            .find(|p| (p.width, p.height) == (832, 480))
            .unwrap();
        assert_eq!(fast.kind, PresetKind::Fast);
    }

    #[test]
    fn custom_sizes_snap_clamp_and_warn() {
        let ok = check_size(&SDXL_RULES, 1024, 1024);
        assert_eq!((ok.width, ok.height, ok.adjusted), (1024, 1024, false));
        assert!(ok.warnings.is_empty());

        let odd = check_size(&SDXL_RULES, 1000, 777);
        assert_eq!((odd.width, odd.height), (1024, 768));
        assert!(odd.adjusted);

        let huge = check_size(&SDXL_RULES, 4000, 4000);
        assert_eq!((huge.width, huge.height), (2048, 2048));
        assert!(huge.warnings.iter().any(|w| w.contains("Larger")));

        let tiny = check_size(&SD1_RULES, 10, 10);
        assert_eq!((tiny.width, tiny.height), (256, 256));
        assert!(tiny.warnings.iter().any(|w| w.contains("Smaller")));

        let flux = check_size(&FLUX_RULES, 1000, 1000);
        assert_eq!((flux.width, flux.height), (1008, 1008));
    }

    #[test]
    fn frames_follow_the_4n_plus_1_rule() {
        for (seconds, fps) in [(1.0, 16), (2.0, 24), (5.0, 24), (3.0, 30), (0.1, 8)] {
            let n = frames_for(seconds, fps, 4, 1);
            assert_eq!(n % 4, 1, "{seconds}s @ {fps}");
            assert!(n >= 5);
        }
        assert_eq!(frames_for(5.0, 24, 4, 1), 121); // Wan 2.2 5B's reference clip
        assert_eq!(frames_for(2.0, 16, 4, 1), 33);
        assert_eq!(frames_for(1.0, 24, 1, 0), 24);
    }

    #[test]
    fn output_targets_are_4k_on_the_long_side() {
        assert_eq!(output_target(1344, 768, 3840), [3840, 2194]);
        assert_eq!(output_target(1280, 720, 3840), [3840, 2160]);
        assert_eq!(output_target(1024, 1024, 3840), [3840, 3840]);
        assert_eq!(output_target(768, 1024, 3840), [2880, 3840]);
        assert_eq!(output_target(512, 512, 0), [512, 512]);
        assert!(find_output_size("4k").is_some());
        assert_eq!(OUTPUT_SIZES[0].long_edge, 0);
    }

    #[test]
    fn esrgan_passes_reach_the_target() {
        assert_eq!(esrgan_passes([1024, 576], [3840, 2160]), 1);
        assert_eq!(esrgan_passes([512, 512], [3840, 3840]), 2);
        assert_eq!(esrgan_passes([4096, 4096], [3840, 3840]), 0);
    }

    #[test]
    fn memory_estimates_grow_with_size_and_frames() {
        let small = estimate_vram_mb(&SDXL_RULES, 8_192, 1024, 1024, None);
        let big = estimate_vram_mb(&SDXL_RULES, 8_192, 2048, 2048, None);
        assert!(small > 8_192 && big > small);
        let short = estimate_vram_mb(&WAN22_5B_RULES, 12_288, 1280, 704, Some(33));
        let long = estimate_vram_mb(&WAN22_5B_RULES, 12_288, 1280, 704, Some(121));
        assert!(long > short);
    }
}
