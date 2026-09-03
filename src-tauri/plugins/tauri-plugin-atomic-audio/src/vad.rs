//! Energy voice-activity detection.
//!
//! Pure state machine: frames in, segment decisions out. No I/O, no clock, no
//! allocation beyond the segment buffer — which makes the whole thing testable
//! with synthetic frames, and keeps it safe under `panic = "abort"`.
//!
//! The job is to cut a continuous microphone stream into phrase-sized pieces at
//! natural pauses. `libmtmd` pads every request to a 30 s window, so segments
//! are capped well below that: a longer one would cost double the audio tokens
//! for no extra words.

use serde::Deserialize;

use crate::dsp::{rms, to_dbfs};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VadParams {
    pub frame_ms: u32,
    /// Hard gate. A frame quieter than this never counts as speech, however
    /// low the adaptive noise floor has drifted.
    pub absolute_floor_dbfs: f32,
    /// How far above the tracked noise floor a frame must sit to be speech.
    pub onset_db_over_floor: f32,
    /// Speech must persist this long before a segment opens — rejects clicks.
    pub min_speech_ms: u32,
    /// Trailing silence that closes a segment.
    pub hangover_ms: u32,
    /// Segments with less actual speech than this are thrown away.
    pub min_segment_ms: u32,
    /// Force-close threshold, to bound latency and stay inside one mtmd window.
    pub max_segment_ms: u32,
    /// Audio retained ahead of the onset so the first phoneme is never clipped.
    pub pre_roll_ms: u32,
}

impl Default for VadParams {
    fn default() -> Self {
        Self {
            frame_ms: 20,
            absolute_floor_dbfs: -45.0,
            onset_db_over_floor: 9.0,
            min_speech_ms: 200,
            hangover_ms: 700,
            min_segment_ms: 400,
            max_segment_ms: 15_000,
            pre_roll_ms: 300,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscardReason {
    /// Opened on a transient that never became a phrase.
    TooShort,
    /// Explicitly abandoned (the user cancelled).
    Aborted,
}

#[derive(Debug)]
pub struct Segment {
    pub samples: Vec<f32>,
    pub start_ms: u64,
    pub end_ms: u64,
}

impl Segment {
    pub fn duration_ms(&self) -> u64 {
        self.end_ms.saturating_sub(self.start_ms)
    }
}

#[derive(Debug, Default)]
pub struct VadOutcome {
    pub rms: f32,
    pub db: f32,
    pub speaking: bool,
    pub segment: Option<Segment>,
    pub discarded: Option<DiscardReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// Speech detected but not yet long enough to commit to a segment.
    Onset,
    Speaking,
}

pub struct Vad {
    params: VadParams,
    sample_rate: u32,
    state: State,

    /// Rolling pre-onset audio, capped at `pre_roll_ms`.
    pre_roll: std::collections::VecDeque<f32>,
    pre_roll_cap: usize,

    /// Audio of the segment currently being built.
    current: Vec<f32>,
    segment_start_ms: u64,
    /// Frames of actual speech in the current segment (silence excluded).
    speech_frames: u32,
    /// Consecutive quiet frames since the last speech frame.
    quiet_frames: u32,
    /// Consecutive loud frames while in `Onset`.
    onset_frames: u32,

    noise_floor_db: Option<f32>,
    seeded_frames: u32,
    frames_seen: u64,
}

impl Vad {
    pub fn new(params: VadParams, sample_rate: u32) -> Self {
        let frame_len = Self::frame_len_for(params.frame_ms, sample_rate);
        let pre_roll_frames = params.pre_roll_ms / params.frame_ms.max(1);

        Self {
            params,
            sample_rate,
            state: State::Idle,
            pre_roll: std::collections::VecDeque::new(),
            pre_roll_cap: frame_len * pre_roll_frames as usize,
            current: Vec::new(),
            segment_start_ms: 0,
            speech_frames: 0,
            quiet_frames: 0,
            onset_frames: 0,
            noise_floor_db: None,
            seeded_frames: 0,
            frames_seen: 0,
        }
    }

    fn frame_len_for(frame_ms: u32, sample_rate: u32) -> usize {
        ((sample_rate as u64 * frame_ms as u64) / 1000) as usize
    }

    /// Samples per VAD frame at this sample rate.
    pub fn frame_len(&self) -> usize {
        Self::frame_len_for(self.params.frame_ms, self.sample_rate)
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.frames_seen * u64::from(self.params.frame_ms)
    }

    fn frames_for(&self, ms: u32) -> u32 {
        (ms / self.params.frame_ms.max(1)).max(1)
    }

    /// Feed exactly one frame. Returns the level plus any segment decision.
    pub fn push_frame(&mut self, frame: &[f32]) -> VadOutcome {
        let level = rms(frame);
        let db = to_dbfs(level);
        self.frames_seen += 1;

        let is_speech = self.classify(db);

        let mut outcome = VadOutcome {
            rms: level,
            db,
            speaking: false,
            segment: None,
            discarded: None,
        };

        match self.state {
            State::Idle => {
                self.remember_pre_roll(frame);
                if is_speech {
                    self.state = State::Onset;
                    self.onset_frames = 1;
                }
            }
            State::Onset => {
                self.remember_pre_roll(frame);
                if is_speech {
                    self.onset_frames += 1;
                    if self.onset_frames >= self.frames_for(self.params.min_speech_ms) {
                        self.open_segment();
                        outcome.speaking = true;
                    }
                } else {
                    self.state = State::Idle;
                    self.onset_frames = 0;
                }
            }
            State::Speaking => {
                outcome.speaking = is_speech;
                self.current.extend_from_slice(frame);

                if is_speech {
                    self.speech_frames += 1;
                    self.quiet_frames = 0;
                } else {
                    self.quiet_frames += 1;
                }

                if self.quiet_frames >= self.frames_for(self.params.hangover_ms) {
                    self.close_segment(&mut outcome, false);
                } else if self.current_duration_ms() >= u64::from(self.params.max_segment_ms) {
                    // Force-close, then continue recording without a gap: the
                    // tail becomes the next segment's pre-roll so a word split
                    // across the boundary survives in both halves.
                    self.close_segment(&mut outcome, true);
                }
            }
        }

        outcome
    }

    /// Close whatever is open, as when the user presses stop.
    pub fn flush(&mut self) -> VadOutcome {
        let mut outcome = VadOutcome::default();
        if self.state == State::Speaking {
            self.close_segment(&mut outcome, false);
        } else {
            self.reset_segment();
        }
        self.state = State::Idle;
        outcome
    }

    /// Throw away whatever is open, as when the user cancels.
    pub fn abort(&mut self) -> VadOutcome {
        let had_segment = self.state == State::Speaking;
        self.reset_segment();
        self.state = State::Idle;
        VadOutcome {
            discarded: had_segment.then_some(DiscardReason::Aborted),
            ..VadOutcome::default()
        }
    }

    fn classify(&mut self, db: f32) -> bool {
        // Seed the floor from the opening moments so a noisy room does not
        // spend the first seconds triggering on its own hum.
        if self.seeded_frames < self.frames_for(300) {
            self.seeded_frames += 1;
            self.noise_floor_db = Some(match self.noise_floor_db {
                Some(current) => current.min(db),
                None => db,
            });
            return false;
        }

        let floor = self.noise_floor_db.unwrap_or(self.params.absolute_floor_dbfs);
        let threshold = (floor + self.params.onset_db_over_floor)
            .max(self.params.absolute_floor_dbfs);
        let is_speech = db > threshold;

        if !is_speech {
            // Track down instantly, up slowly (0.5 dB/s), so the floor follows a
            // fan spinning up without chasing the user's voice.
            let rise = 0.5 * self.params.frame_ms as f32 / 1000.0;
            self.noise_floor_db = Some(match self.noise_floor_db {
                Some(current) => db.min(current + rise),
                None => db,
            });
        }

        is_speech
    }

    fn remember_pre_roll(&mut self, frame: &[f32]) {
        if self.pre_roll_cap == 0 {
            return;
        }
        self.pre_roll.extend(frame.iter().copied());
        while self.pre_roll.len() > self.pre_roll_cap {
            self.pre_roll.pop_front();
        }
    }

    fn open_segment(&mut self) {
        self.state = State::Speaking;
        self.current.clear();
        self.current.extend(self.pre_roll.iter().copied());
        self.pre_roll.clear();

        let pre_roll_ms = self.samples_to_ms(self.current.len());
        self.segment_start_ms = self.elapsed_ms().saturating_sub(pre_roll_ms);
        self.speech_frames = self.onset_frames;
        self.quiet_frames = 0;
        self.onset_frames = 0;
    }

    fn close_segment(&mut self, outcome: &mut VadOutcome, continue_recording: bool) {
        let speech_ms = u64::from(self.speech_frames) * u64::from(self.params.frame_ms);
        let samples = std::mem::take(&mut self.current);
        let end_ms = self.elapsed_ms();

        if speech_ms >= u64::from(self.params.min_segment_ms) {
            outcome.segment = Some(Segment {
                samples: samples.clone(),
                start_ms: self.segment_start_ms,
                end_ms,
            });
        } else {
            outcome.discarded = Some(DiscardReason::TooShort);
        }

        if continue_recording {
            // Bridge the split: the tail of what we just emitted becomes the
            // head of the next segment.
            let tail_start = samples.len().saturating_sub(self.pre_roll_cap);
            self.current = samples[tail_start..].to_vec();
            self.segment_start_ms = end_ms.saturating_sub(self.samples_to_ms(self.current.len()));
            self.speech_frames = 0;
            self.quiet_frames = 0;
            self.state = State::Speaking;
        } else {
            self.reset_segment();
            self.state = State::Idle;
        }
    }

    fn reset_segment(&mut self) {
        self.current.clear();
        self.pre_roll.clear();
        self.speech_frames = 0;
        self.quiet_frames = 0;
        self.onset_frames = 0;
    }

    fn current_duration_ms(&self) -> u64 {
        self.samples_to_ms(self.current.len())
    }

    fn samples_to_ms(&self, samples: usize) -> u64 {
        if self.sample_rate == 0 {
            return 0;
        }
        (samples as u64 * 1000) / u64::from(self.sample_rate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16_000;

    fn vad() -> Vad {
        Vad::new(VadParams::default(), RATE)
    }

    fn silence(v: &Vad) -> Vec<f32> {
        vec![0.0; v.frame_len()]
    }

    /// A loud frame: full-scale alternating samples, ~0 dBFS.
    fn speech(v: &Vad) -> Vec<f32> {
        (0..v.frame_len())
            .map(|i| if i % 2 == 0 { 0.6 } else { -0.6 })
            .collect()
    }

    fn feed(v: &mut Vad, frame: &[f32], ms: u32) -> Vec<VadOutcome> {
        let frames = ms / VadParams::default().frame_ms;
        (0..frames).map(|_| v.push_frame(frame)).collect()
    }

    #[test]
    fn silence_alone_never_opens_a_segment() {
        let mut v = vad();
        let quiet = silence(&v);
        let outcomes = feed(&mut v, &quiet, 3_000);
        assert!(outcomes.iter().all(|o| o.segment.is_none()));
        assert!(outcomes.iter().all(|o| !o.speaking));
    }

    #[test]
    fn one_phrase_between_pauses_yields_exactly_one_segment() {
        let mut v = vad();
        let quiet = silence(&v);
        let loud = speech(&v);

        let mut outcomes = feed(&mut v, &quiet, 1_000);
        outcomes.extend(feed(&mut v, &loud, 2_000));
        outcomes.extend(feed(&mut v, &quiet, 1_000));

        let segments: Vec<_> = outcomes.iter().filter_map(|o| o.segment.as_ref()).collect();
        assert_eq!(segments.len(), 1, "expected one segment");

        let seg = segments[0];
        // 2 s of speech, plus pre-roll ahead of it and the hangover behind it.
        let expected = 2_000 + u64::from(VadParams::default().pre_roll_ms);
        assert!(
            seg.duration_ms() >= expected,
            "duration {} < {expected}",
            seg.duration_ms()
        );
        assert!(seg.samples.len() > RATE as usize * 2, "segment too short");
    }

    #[test]
    fn a_short_burst_never_becomes_a_segment() {
        let mut v = vad();
        let quiet = silence(&v);
        let loud = speech(&v);

        let mut outcomes = feed(&mut v, &quiet, 1_000);
        outcomes.extend(feed(&mut v, &loud, 100)); // below min_speech_ms
        outcomes.extend(feed(&mut v, &quiet, 1_000));

        assert!(outcomes.iter().all(|o| o.segment.is_none()));
    }

    #[test]
    fn a_burst_that_opens_but_stays_brief_is_discarded_as_too_short() {
        let mut v = Vad::new(
            VadParams {
                min_speech_ms: 100,
                min_segment_ms: 400,
                ..VadParams::default()
            },
            RATE,
        );
        let quiet = silence(&v);
        let loud = speech(&v);

        let mut outcomes = feed(&mut v, &quiet, 1_000);
        outcomes.extend(feed(&mut v, &loud, 200)); // opens, but < min_segment_ms
        outcomes.extend(feed(&mut v, &quiet, 1_000));

        assert!(outcomes.iter().all(|o| o.segment.is_none()));
        assert!(outcomes
            .iter()
            .any(|o| o.discarded == Some(DiscardReason::TooShort)));
    }

    #[test]
    fn continuous_speech_is_split_at_the_max_segment_length() {
        let mut v = Vad::new(
            VadParams {
                max_segment_ms: 2_000,
                ..VadParams::default()
            },
            RATE,
        );
        let quiet = silence(&v);
        let loud = speech(&v);

        let mut outcomes = feed(&mut v, &quiet, 500);
        outcomes.extend(feed(&mut v, &loud, 9_000));

        let segments: Vec<_> = outcomes.iter().filter_map(|o| o.segment.as_ref()).collect();
        assert!(
            segments.len() >= 4,
            "expected 9 s / 2 s to split into 4+ segments, got {}",
            segments.len()
        );
        for seg in &segments {
            assert!(
                seg.duration_ms() <= 2_600,
                "segment ran long: {} ms",
                seg.duration_ms()
            );
        }
    }

    #[test]
    fn a_rising_noise_floor_does_not_open_a_segment() {
        let mut v = vad();
        let mut outcomes = Vec::new();
        // Ramp the room from -70 dBFS to about -50 dBFS over 10 seconds.
        for i in 0..500u32 {
            let amp = 0.0003 + 0.0027 * (i as f32 / 500.0);
            let frame: Vec<f32> = (0..v.frame_len())
                .map(|n| if n % 2 == 0 { amp } else { -amp })
                .collect();
            outcomes.push(v.push_frame(&frame));
        }
        assert!(outcomes.iter().all(|o| o.segment.is_none()));
    }

    #[test]
    fn flush_emits_the_phrase_still_in_progress() {
        let mut v = vad();
        let quiet = silence(&v);
        let loud = speech(&v);

        feed(&mut v, &quiet, 1_000);
        feed(&mut v, &loud, 1_000);
        let outcome = v.flush();

        let seg = outcome.segment.expect("flush should emit the open segment");
        assert!(seg.samples.len() > RATE as usize / 2);
    }

    #[test]
    fn abort_drops_the_phrase_still_in_progress() {
        let mut v = vad();
        let quiet = silence(&v);
        let loud = speech(&v);

        feed(&mut v, &quiet, 1_000);
        feed(&mut v, &loud, 1_000);
        let outcome = v.abort();

        assert!(outcome.segment.is_none());
        assert_eq!(outcome.discarded, Some(DiscardReason::Aborted));
    }

    #[test]
    fn frame_len_matches_the_configured_frame_duration() {
        let v = vad();
        assert_eq!(v.frame_len(), 320); // 20 ms at 16 kHz
    }
}
