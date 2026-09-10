//! Channel downmix, anti-aliased resampling to 16 kHz, and RMS.
//!
//! Voxtral's audio encoder wants 16 kHz mono. Capture devices hand us whatever
//! they like — usually 44.1 or 48 kHz, often stereo — so everything is funnelled
//! through here before it reaches the VAD or the WAV encoder.
//!
//! `libmtmd` embeds miniaudio and could resample server-side, but doing it here
//! keeps the wire format deterministic and cuts the payload roughly threefold.
//!
//! NOTE: the release profile sets `panic = "abort"`, and this code runs one
//! thread away from the audio callback. No `unwrap`, no unchecked indexing.

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Number of FIR taps. Odd so the filter has an integer group delay, and long
/// enough that the transition band fits between 7.2 kHz and Nyquist at 48 kHz.
const FIR_TAPS: usize = 63;

/// Anti-alias cutoff. Below the 8 kHz Nyquist of the target rate with enough
/// room for the Hamming window's transition width.
const CUTOFF_HZ: f32 = 7_200.0;

/// Average interleaved frames down to mono, appending to `out`.
pub fn downmix_into(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    for frame in interleaved.chunks_exact(channels) {
        let sum: f32 = frame.iter().sum();
        out.push(sum / channels as f32);
    }
}

/// Root mean square of a frame, in `0.0..=1.0` for in-range input.
pub fn rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = frame.iter().map(|s| s * s).sum();
    (sum_sq / frame.len() as f32).sqrt()
}

/// Convert a linear amplitude to dBFS, floored so silence does not become -inf.
pub fn to_dbfs(amplitude: f32) -> f32 {
    20.0 * amplitude.max(1e-7).log10()
}

fn sinc(x: f32) -> f32 {
    if x.abs() < 1e-6 {
        1.0
    } else {
        let pix = std::f32::consts::PI * x;
        pix.sin() / pix
    }
}

/// Windowed-sinc low-pass, normalised to unity DC gain.
fn build_taps(src_rate: f32) -> Box<[f32]> {
    let half = (FIR_TAPS / 2) as f32;
    // Cycles per input sample.
    let fc = (CUTOFF_HZ / src_rate).min(0.5);

    let mut taps = vec![0.0f32; FIR_TAPS];
    let mut sum = 0.0f32;
    for (n, tap) in taps.iter_mut().enumerate() {
        let offset = n as f32 - half;
        // Hamming window
        let window = 0.54
            - 0.46 * (2.0 * std::f32::consts::PI * n as f32 / (FIR_TAPS as f32 - 1.0)).cos();
        let value = 2.0 * fc * sinc(2.0 * fc * offset) * window;
        *tap = value;
        sum += value;
    }
    if sum.abs() > 1e-9 {
        for tap in taps.iter_mut() {
            *tap /= sum;
        }
    }
    taps.into_boxed_slice()
}

/// Streaming resampler: interleaved input at any rate → mono at 16 kHz.
///
/// Carries its filter history across chunks, so feeding one large buffer and
/// feeding the same audio in small pieces produce identical output. Without
/// that the chunk boundaries click audibly.
pub struct Resampler {
    channels: usize,
    /// Input samples per output sample.
    step: f64,
    taps: Box<[f32]>,
    half: usize,
    /// Mono samples awaiting output. The first `half` are filter context.
    buf: Vec<f32>,
    /// Read position, in `buf` indices.
    pos: f64,
    passthrough: bool,
}

impl Resampler {
    pub fn new(src_rate: u32, channels: u16) -> Self {
        let channels = channels.max(1) as usize;
        let passthrough = src_rate == TARGET_SAMPLE_RATE;
        let half = FIR_TAPS / 2;

        Self {
            channels,
            step: f64::from(src_rate) / f64::from(TARGET_SAMPLE_RATE),
            taps: if passthrough {
                Vec::new().into_boxed_slice()
            } else {
                build_taps(src_rate as f32)
            },
            half,
            // Pre-seed the delay line so the very first real sample already has
            // a full window and nothing is clipped off the start of speech.
            buf: if passthrough {
                Vec::new()
            } else {
                vec![0.0; half]
            },
            pos: if passthrough { 0.0 } else { half as f64 },
            passthrough,
        }
    }

    /// Feed one capture buffer, appending 16 kHz mono samples to `out`.
    pub fn push(&mut self, interleaved: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            downmix_into(interleaved, self.channels, out);
            return;
        }

        downmix_into(interleaved, self.channels, &mut self.buf);

        // Highest index whose filter window is fully inside `buf`.
        let Some(max_center) = self.buf.len().checked_sub(self.half + 1) else {
            return;
        };

        while self.pos.floor() as usize + 1 <= max_center {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - self.pos.floor()) as f32;
            let a = self.filter_at(i);
            let b = self.filter_at(i + 1);
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }

        // Drop everything the filter can no longer reach back to.
        let keep_from = (self.pos.floor() as usize).saturating_sub(self.half);
        if keep_from > 0 {
            self.buf.drain(0..keep_from);
            self.pos -= keep_from as f64;
        }
    }

    fn filter_at(&self, center: usize) -> f32 {
        let start = center.saturating_sub(self.half);
        let mut acc = 0.0f32;
        for (k, tap) in self.taps.iter().enumerate() {
            match self.buf.get(start + k) {
                Some(sample) => acc += tap * sample,
                None => break,
            }
        }
        acc
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|n| {
                (2.0 * std::f32::consts::PI * freq * n as f32 / rate as f32).sin()
            })
            .collect()
    }

    /// Count sign changes, ignoring the settling edges where the FIR ramps up.
    fn zero_crossings(samples: &[f32]) -> usize {
        let skip = samples.len() / 10;
        let core = &samples[skip..samples.len().saturating_sub(skip)];
        core.windows(2)
            .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
            .count()
    }

    fn peak(samples: &[f32]) -> f32 {
        let skip = samples.len() / 4;
        samples[skip..]
            .iter()
            .fold(0.0f32, |acc, s| acc.max(s.abs()))
    }

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix_into(&[1.0, 0.0, 0.5, -0.5], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.0]);
    }

    #[test]
    fn downmix_passes_mono_through() {
        let mut out = Vec::new();
        downmix_into(&[0.25, -0.25], 1, &mut out);
        assert_eq!(out, vec![0.25, -0.25]);
    }

    #[test]
    fn rms_and_dbfs_are_sane() {
        assert!((rms(&[1.0, -1.0, 1.0, -1.0]) - 1.0).abs() < 1e-6);
        assert_eq!(rms(&[]), 0.0);
        assert!((to_dbfs(1.0) - 0.0).abs() < 1e-4);
        assert!(to_dbfs(0.0) < -100.0);
    }

    #[test]
    fn passthrough_at_16k_is_bit_exact() {
        let input = sine(1_000.0, 16_000, 1_600);
        let mut out = Vec::new();
        Resampler::new(16_000, 1).push(&input, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn a_1khz_tone_survives_48k_to_16k() {
        let input = sine(1_000.0, 48_000, 48_000); // 1 second
        let mut out = Vec::new();
        Resampler::new(48_000, 1).push(&input, &mut out);

        // 1 s at 16 kHz, allowing for filter latency.
        assert!(out.len() > 15_800 && out.len() <= 16_000, "len {}", out.len());

        // 1 kHz over the ~0.8 s core region => ~1600 crossings.
        let crossings = zero_crossings(&out);
        let expected = 2.0 * 1_000.0 * 0.8;
        assert!(
            (crossings as f32 - expected).abs() / expected < 0.02,
            "crossings {crossings}, expected ~{expected}"
        );

        // And it must still be there at full amplitude.
        assert!(peak(&out) > 0.9, "peak {}", peak(&out));
    }

    #[test]
    fn a_12khz_tone_is_rejected_by_the_anti_alias_filter() {
        // Without the FIR this would alias down to 4 kHz at full amplitude.
        let input = sine(12_000.0, 48_000, 48_000);
        let mut out = Vec::new();
        Resampler::new(48_000, 1).push(&input, &mut out);

        let attenuation_db = 20.0 * peak(&out).max(1e-7).log10();
        assert!(
            attenuation_db < -40.0,
            "12 kHz only attenuated to {attenuation_db} dB"
        );
    }

    #[test]
    fn chunk_boundaries_do_not_change_the_output() {
        let input = sine(1_000.0, 48_000, 4_800);

        let mut whole = Vec::new();
        Resampler::new(48_000, 1).push(&input, &mut whole);

        let mut pieces = Vec::new();
        let mut chunked = Resampler::new(48_000, 1);
        for chunk in input.chunks(480) {
            chunked.push(chunk, &mut pieces);
        }

        assert_eq!(whole.len(), pieces.len());
        for (a, b) in whole.iter().zip(pieces.iter()) {
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
    }

    #[test]
    fn non_integer_ratios_produce_the_expected_sample_count() {
        let input = sine(440.0, 44_100, 44_100);
        let mut out = Vec::new();
        Resampler::new(44_100, 1).push(&input, &mut out);

        let expected = 44_100.0 * 16_000.0 / 44_100.0;
        assert!(
            (out.len() as f32 - expected).abs() < 64.0,
            "len {} vs expected ~{expected}",
            out.len()
        );
    }

    #[test]
    fn stereo_input_is_downmixed_before_resampling() {
        let mono = sine(1_000.0, 48_000, 4_800);
        let mut interleaved = Vec::with_capacity(mono.len() * 2);
        for s in &mono {
            interleaved.push(*s);
            interleaved.push(*s);
        }

        let mut from_mono = Vec::new();
        Resampler::new(48_000, 1).push(&mono, &mut from_mono);
        let mut from_stereo = Vec::new();
        Resampler::new(48_000, 2).push(&interleaved, &mut from_stereo);

        assert_eq!(from_mono.len(), from_stereo.len());
        for (a, b) in from_mono.iter().zip(from_stereo.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
