//! Minimal RIFF/WAVE writer.
//!
//! `libmtmd` sniffs the `RIFF`/`WAVE` magic and fails with "Unable to read WAV
//! audio file from buffer" on anything malformed, so the header has to be
//! exactly canonical. Hand-rolled rather than pulling in `hound`: it is 40
//! lines, and being able to assert the bytes is worth more than the dependency.
//!
//! NOTE: the release profile sets `panic = "abort"`. Everything here is
//! allocation-and-arithmetic only — no indexing that can go out of bounds, no
//! `unwrap`.

/// Canonical PCM WAV header length: 12 (RIFF) + 24 (fmt ) + 8 (data).
pub const HEADER_LEN: usize = 44;

const BITS_PER_SAMPLE: u16 = 16;
const CHANNELS: u16 = 1;

/// Encode mono f32 samples in `-1.0..=1.0` as a 16-bit PCM WAV file.
///
/// Samples outside the range are clamped rather than wrapped — a wrapped sample
/// is an audible click, and clipping is what every other encoder does.
pub fn encode_pcm16_mono(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(HEADER_LEN + data_len);

    let byte_rate = sample_rate * u32::from(CHANNELS) * u32::from(BITS_PER_SAMPLE) / 8;
    let block_align = CHANNELS * BITS_PER_SAMPLE / 8;

    // RIFF chunk descriptor
    out.extend_from_slice(b"RIFF");
    // Size of everything after this field. Saturating so a pathological input
    // truncates instead of panicking in a debug build.
    out.extend_from_slice(&((36u32).saturating_add(data_len as u32)).to_le_bytes());
    out.extend_from_slice(b"WAVE");

    // fmt sub-chunk
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format: 1 = PCM
    out.extend_from_slice(&CHANNELS.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());

    // data sub-chunk
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&to_i16(*sample).to_le_bytes());
    }

    out
}

#[inline]
fn to_i16(sample: f32) -> i16 {
    if sample.is_nan() {
        return 0;
    }
    let clamped = sample.clamp(-1.0, 1.0);
    // Asymmetric on purpose: -1.0 maps to i16::MIN, +1.0 to i16::MAX.
    if clamped < 0.0 {
        (clamped * 32768.0).max(f32::from(i16::MIN)) as i16
    } else {
        (clamped * 32767.0) as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    }

    fn u16_at(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
    }

    #[test]
    fn header_is_exactly_44_bytes_and_well_formed() {
        let wav = encode_pcm16_mono(&[0.0; 100], 16_000);

        assert_eq!(wav.len(), HEADER_LEN + 200);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32_at(&wav, 4), 36 + 200);
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32_at(&wav, 16), 16);
        assert_eq!(u16_at(&wav, 20), 1); // PCM
        assert_eq!(u16_at(&wav, 22), 1); // mono
        assert_eq!(u32_at(&wav, 24), 16_000);
        assert_eq!(u32_at(&wav, 28), 16_000 * 2); // byte rate
        assert_eq!(u16_at(&wav, 32), 2); // block align
        assert_eq!(u16_at(&wav, 34), 16); // bits per sample
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32_at(&wav, 40), 200);
    }

    #[test]
    fn empty_input_still_produces_a_valid_header() {
        let wav = encode_pcm16_mono(&[], 16_000);
        assert_eq!(wav.len(), HEADER_LEN);
        assert_eq!(u32_at(&wav, 4), 36);
        assert_eq!(u32_at(&wav, 40), 0);
    }

    #[test]
    fn samples_round_trip_through_i16() {
        let wav = encode_pcm16_mono(&[0.0, 0.5, -0.5, 1.0, -1.0], 16_000);
        let decoded: Vec<i16> = wav[HEADER_LEN..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();

        assert_eq!(decoded[0], 0);
        assert_eq!(decoded[1], 16383);
        assert_eq!(decoded[2], -16384);
        assert_eq!(decoded[3], i16::MAX);
        assert_eq!(decoded[4], i16::MIN);
    }

    #[test]
    fn out_of_range_samples_clamp_instead_of_wrapping() {
        let wav = encode_pcm16_mono(&[1.5, -1.5, f32::NAN, f32::INFINITY], 16_000);
        let decoded: Vec<i16> = wav[HEADER_LEN..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();

        assert_eq!(decoded[0], i16::MAX);
        assert_eq!(decoded[1], i16::MIN);
        assert_eq!(decoded[2], 0);
        assert_eq!(decoded[3], i16::MAX);
    }

    #[test]
    fn sample_rate_is_reflected_in_the_derived_fields() {
        let wav = encode_pcm16_mono(&[0.0; 4], 48_000);
        assert_eq!(u32_at(&wav, 24), 48_000);
        assert_eq!(u32_at(&wav, 28), 96_000);
    }
}
