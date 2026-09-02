//! Talking to llama-server's OpenAI-compatible transcription endpoint.
//!
//! The bundled upstream `llama-server` already serves
//! `POST /v1/audio/transcriptions`. Its handler signature —
//! `convert_transcriptions_to_chatcmpl(const json&, const common_chat_templates*,
//! const std::map<std::string, uploaded_file>&, std::vector<raw_buffer>&)` —
//! shows files arrive keyed by multipart field name, so the field *must* be
//! called `file`. `response_format` must be `json`; the server rejects anything
//! else outright.
//!
//! The request is built and sent here rather than in the web app because Tauri
//! v2 serialises `Vec<u8>` as a JSON array of numbers: a 4-second segment would
//! cross the IPC bridge as roughly half a megabyte of JSON, several times a
//! minute.

use crate::error::{AudioError, AudioErrorCode, AudioResult};

/// Multipart field carrying the audio. Fixed by the server's handler.
const FILE_FIELD: &str = "file";
const FILE_NAME: &str = "segment.wav";

/// Upper bound on how fast anyone talks, in characters per second of audio.
///
/// Ordinary speech runs 12-15. Thirty leaves room for a fast speaker and for
/// the fact that a segment's timestamps span its pre-roll and hangover as well
/// as the words, so the real speech is always shorter than `duration_ms`.
const MAX_CHARS_PER_SECOND: f32 = 30.0;

/// Flat allowance on top of the rate, for short segments where one word plus
/// its punctuation already outruns any per-second budget.
const CHAR_ALLOWANCE: usize = 48;

/// Could this text have come out of `duration_ms` of someone talking?
///
/// `/v1/audio/transcriptions` is a chat completion wearing a different name:
/// `convert_transcriptions_to_chatcmpl` feeds the audio to the same instruct
/// model through the same template. Hand it a segment with nothing intelligible
/// in it and the model does what instruct models do — it answers. A page of
/// advice about Descript and Amazon Transcribe is not a transcript of two
/// seconds of room noise, and splicing it into the composer is far worse than
/// dropping the phrase.
///
/// The test is deliberately coarse. It has to reject an essay without ever
/// eating a real sentence, so every threshold errs towards letting text
/// through.
pub fn is_plausible_transcript(text: &str, duration_ms: u64) -> bool {
    if text.is_empty() {
        return true;
    }
    // Nobody dictates a fenced code block.
    if text.contains("```") {
        return false;
    }
    // A phrase is one utterance. Several paragraphs is the model writing prose.
    if text.matches('\n').count() > 2 {
        return false;
    }

    let budget =
        CHAR_ALLOWANCE + (MAX_CHARS_PER_SECOND * duration_ms as f32 / 1000.0) as usize;
    text.chars().count() <= budget
}

#[derive(Debug, Clone)]
pub struct TranscriptionTarget {
    /// e.g. `http://127.0.0.1:8123/v1`
    pub base_url: String,
    pub api_key: String,
    /// The llama-server alias (`-a`), which is our model id.
    pub model: String,
    pub language: Option<String>,
    pub prompt: Option<String>,
    pub timeout_secs: u64,
}

impl TranscriptionTarget {
    pub fn endpoint(&self) -> String {
        format!("{}/audio/transcriptions", self.base_url.trim_end_matches('/'))
    }
}

/// Build a `multipart/form-data` body by hand.
///
/// CRLF discipline is the classic source of "No input file found" — every part
/// header line and every part terminator ends with `\r\n`, including the last.
pub fn build_multipart(boundary: &str, wav: &[u8], fields: &[(&str, &str)]) -> Vec<u8> {
    let mut body = Vec::with_capacity(wav.len() + 512);

    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }

    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{FILE_FIELD}\"; filename=\"{FILE_NAME}\"\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    body.extend_from_slice(wav);
    body.extend_from_slice(b"\r\n");

    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

/// Fields sent alongside the audio, in a stable order so the body is testable.
pub fn build_fields(target: &TranscriptionTarget) -> Vec<(&str, &str)> {
    let mut fields: Vec<(&str, &str)> = vec![
        ("model", target.model.as_str()),
        ("response_format", "json"),
        ("temperature", "0"),
    ];
    // The server's only `language`-bearing literal is the format string
    // " (language: %s)", so the field is very likely read and appended to the
    // prompt. Sending it is harmless if it is not — and the caller also folds
    // the hint into `prompt`, which is definitely read.
    if let Some(language) = target.language.as_deref() {
        if !language.is_empty() && language != "auto" {
            fields.push(("language", language));
        }
    }
    if let Some(prompt) = target.prompt.as_deref() {
        if !prompt.is_empty() {
            fields.push(("prompt", prompt));
        }
    }
    fields
}

/// Pull the transcript out of a `200` body, or classify the server's error.
pub fn parse_response(status: u16, body: &str) -> AudioResult<String> {
    if status == 200 {
        let value: serde_json::Value = serde_json::from_str(body).map_err(|e| {
            AudioError::with_details(
                AudioErrorCode::TranscriptionFailed,
                "The transcription response could not be read.",
                e.to_string(),
            )
        })?;
        let text = value
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        return Ok(text);
    }

    Err(classify_error(status, body))
}

/// Map an HTTP failure onto an actionable code.
pub fn classify_error(status: u16, body: &str) -> AudioError {
    let message = extract_server_message(body).unwrap_or_else(|| body.trim().to_string());
    let lower = message.to_lowercase();

    // Terminal: this build or this model cannot do audio at all. Retrying is
    // pointless and the user needs to hear why.
    if lower.contains("does not support audio input") || lower.contains("no audio encoder") {
        return AudioError::with_details(
            AudioErrorCode::TranscriptionUnsupported,
            "This model can't transcribe audio.",
            message,
        );
    }

    // Our own bug: we built a request the server rejects on shape.
    if lower.contains("no input file found") || lower.contains("response_format") {
        return AudioError::with_details(
            AudioErrorCode::Internal,
            "The transcription request was malformed.",
            message,
        );
    }

    match status {
        401 | 403 => AudioError::with_details(
            AudioErrorCode::Internal,
            "The transcription server rejected our credentials.",
            message,
        ),
        404 => AudioError::with_details(
            AudioErrorCode::TranscriptionUnsupported,
            "This llama.cpp build has no transcription endpoint.",
            message,
        ),
        503 => AudioError::with_details(
            AudioErrorCode::ServerUnreachable,
            "The transcription server is not ready.",
            message,
        ),
        _ => AudioError::with_details(
            AudioErrorCode::TranscriptionFailed,
            "That phrase couldn't be transcribed.",
            message,
        ),
    }
}

/// llama-server errors look like `{"error":{"message":"…","code":500}}`.
fn extract_server_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .get("error")
        .and_then(|e| e.get("message"))
        .or_else(|| value.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/// A boundary that cannot collide with WAV bytes.
pub fn make_boundary(seed: u64) -> String {
    // No RNG dependency: the session id and a counter already make this unique
    // per request, and multipart only needs the boundary to not appear in the
    // payload.
    format!("----atomic-audio-{seed:016x}{:016x}", seed.rotate_left(17))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn transcribe(
    client: &reqwest::Client,
    target: &TranscriptionTarget,
    wav: &[u8],
    seed: u64,
) -> AudioResult<String> {
    let boundary = make_boundary(seed);
    let fields = build_fields(target);
    let body = build_multipart(&boundary, wav, &fields);

    let response = client
        .post(target.endpoint())
        .header("Authorization", format!("Bearer {}", target.api_key))
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                AudioError::with_details(
                    AudioErrorCode::TranscriptionTimeout,
                    "The voice model took too long to answer.",
                    e.to_string(),
                )
            } else {
                AudioError::with_details(
                    AudioErrorCode::ServerUnreachable,
                    "The voice model isn't reachable.",
                    e.to_string(),
                )
            }
        })?;

    let status = response.status().as_u16();
    let text = response.text().await.map_err(|e| {
        AudioError::with_details(
            AudioErrorCode::TranscriptionFailed,
            "The transcription response could not be read.",
            e.to_string(),
        )
    })?;

    parse_response(status, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> TranscriptionTarget {
        TranscriptionTarget {
            base_url: "http://127.0.0.1:9000/v1".into(),
            api_key: "k".into(),
            model: "ggml-org/Voxtral-Mini-3B-2507-Q4_K_M".into(),
            language: None,
            prompt: None,
            timeout_secs: 60,
        }
    }

    #[test]
    fn endpoint_is_built_without_a_double_slash() {
        assert_eq!(
            target().endpoint(),
            "http://127.0.0.1:9000/v1/audio/transcriptions"
        );
        let mut t = target();
        t.base_url = "http://127.0.0.1:9000/v1/".into();
        assert_eq!(t.endpoint(), "http://127.0.0.1:9000/v1/audio/transcriptions");
    }

    #[test]
    fn multipart_body_is_byte_exact() {
        let body = build_multipart("BOUND", &[0xAA, 0xBB], &[("model", "m")]);
        let expected = concat!(
            "--BOUND\r\n",
            "Content-Disposition: form-data; name=\"model\"\r\n\r\n",
            "m\r\n",
            "--BOUND\r\n",
            "Content-Disposition: form-data; name=\"file\"; filename=\"segment.wav\"\r\n",
            "Content-Type: audio/wav\r\n\r\n",
        );
        let mut want = expected.as_bytes().to_vec();
        want.extend_from_slice(&[0xAA, 0xBB]);
        want.extend_from_slice(b"\r\n--BOUND--\r\n");

        assert_eq!(body, want);
    }

    #[test]
    fn required_fields_are_always_present() {
        let t = target();
        let fields = build_fields(&t);
        assert!(fields.contains(&("model", "ggml-org/Voxtral-Mini-3B-2507-Q4_K_M")));
        assert!(fields.contains(&("response_format", "json")));
    }

    #[test]
    fn auto_language_is_not_sent() {
        let mut t = target();
        t.language = Some("auto".into());
        assert!(build_fields(&t).iter().all(|(k, _)| *k != "language"));

        t.language = Some("ru".into());
        assert!(build_fields(&t).contains(&("language", "ru")));
    }

    #[test]
    fn a_successful_response_yields_trimmed_text() {
        assert_eq!(
            parse_response(200, r#"{"text":"  hello there \n"}"#).unwrap(),
            "hello there"
        );
    }

    #[test]
    fn an_empty_transcript_is_success_not_failure() {
        // "no speech" must not surface as an error toast.
        assert_eq!(parse_response(200, r#"{"text":""}"#).unwrap(), "");
        assert_eq!(parse_response(200, r#"{}"#).unwrap(), "");
    }

    #[test]
    fn a_model_without_an_audio_encoder_is_terminal() {
        let err = parse_response(
            400,
            r#"{"error":{"message":"The current model does not support audio input.","code":400}}"#,
        )
        .unwrap_err();
        assert_eq!(err.code, AudioErrorCode::TranscriptionUnsupported);
    }

    #[test]
    fn a_malformed_request_is_reported_as_our_bug() {
        let err =
            parse_response(400, r#"{"error":{"message":"No input file found for transcription"}}"#)
                .unwrap_err();
        assert_eq!(err.code, AudioErrorCode::Internal);
    }

    #[test]
    fn a_server_500_is_retryable_rather_than_terminal() {
        let err = parse_response(500, r#"{"error":{"message":"internal"}}"#).unwrap_err();
        assert_eq!(err.code, AudioErrorCode::TranscriptionFailed);
        assert_eq!(err.details.as_deref(), Some("internal"));
    }

    #[test]
    fn a_non_json_error_body_still_classifies() {
        let err = parse_response(502, "Bad Gateway").unwrap_err();
        assert_eq!(err.code, AudioErrorCode::TranscriptionFailed);
        assert_eq!(err.details.as_deref(), Some("Bad Gateway"));
    }

    #[test]
    fn a_real_phrase_is_plausible_for_its_duration() {
        // ~2.5 s of speech, pre-roll and hangover included.
        assert!(is_plausible_transcript(
            "Привет, давай посмотрим что там с этим билдом",
            2_500
        ));
        assert!(is_plausible_transcript("Yes.", 900));
        assert!(is_plausible_transcript("", 1_200));
    }

    #[test]
    fn a_fast_speaker_is_not_cut_off() {
        // 15 s — the longest segment the VAD emits — at a brisk 20 chars/s.
        let fast = "a".repeat(300);
        assert!(is_plausible_transcript(&fast, 15_000));
    }

    #[test]
    fn an_instruct_answer_to_silence_is_rejected() {
        // What the model actually returned for a segment of room noise.
        let essay = "I'm unable to transcribe audio directly. However, I can \
guide you on how to use various tools and services to transcribe audio. Here \
are a few options: Google Drive, Descript, Rev, Trint, Amazon Transcribe."
            .repeat(4);
        assert!(!is_plausible_transcript(&essay, 1_400));
    }

    #[test]
    fn markdown_is_never_speech() {
        assert!(!is_plausible_transcript("run ```ffmpeg -i in.wav```", 8_000));
        assert!(!is_plausible_transcript("one\ntwo\nthree\nfour", 8_000));
    }

    #[test]
    fn boundaries_differ_per_seed() {
        assert_ne!(make_boundary(1), make_boundary(2));
        assert!(make_boundary(7).starts_with("----atomic-audio-"));
    }
}
