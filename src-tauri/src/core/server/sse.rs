//! Incremental, line-oriented reader for Server-Sent Event streams.
//!
//! Extracted from the `/responses` shim so the shim, the generic streaming
//! relay and the Anthropic transform can all share one implementation.
//!
//! The reader hands back every line's **original bytes** alongside the parsed
//! `data:` payload. That byte fidelity is what lets a caller inspect a stream
//! while still forwarding it to the client unchanged: forward each `raw` and
//! the client sees exactly what the upstream sent.

/// Beyond this a "line" is assumed not to be SSE at all. Flush it rather than
/// buffering an entire non-SSE response in memory.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// The payload of a `data:` line.
#[derive(Debug, PartialEq)]
pub(crate) enum SseData {
    /// The `[DONE]` sentinel.
    Done,
    /// A JSON object.
    Json(serde_json::Value),
    /// A `data:` line that is neither JSON nor `[DONE]`. Reported rather than
    /// dropped so callers that forward `raw` never lose bytes.
    Raw(String),
}

/// One line of an SSE stream.
#[derive(Debug, PartialEq)]
pub(crate) enum SseLine {
    /// A `data:` line, with its payload pre-parsed.
    Data {
        raw: Vec<u8>,
        payload: SseData,
    },
    /// `event:`, `id:`, `retry:`, a comment, or the blank event separator.
    Other { raw: Vec<u8> },
}

impl SseLine {
    /// The line's original bytes, including its trailing newline when it had
    /// one. Forwarding these verbatim reproduces the upstream stream exactly.
    pub(crate) fn raw(&self) -> &[u8] {
        match self {
            SseLine::Data { raw, .. } | SseLine::Other { raw } => raw,
        }
    }
}

/// Reassembles SSE lines across arbitrary chunk boundaries.
#[derive(Default)]
pub(crate) struct SseLineReader {
    buf: Vec<u8>,
}

impl SseLineReader {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Feeds raw upstream bytes. Call `next_line` until it returns `None`.
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    /// Pops the next complete line, or `None` when more bytes are needed.
    pub(crate) fn next_line(&mut self) -> Option<SseLine> {
        let raw: Vec<u8> = match self.buf.iter().position(|&b| b == b'\n') {
            Some(pos) => self.buf.drain(..=pos).collect(),
            None => {
                if self.buf.len() >= MAX_LINE_BYTES {
                    // Not SSE, or a pathological line. Flush so we stop growing.
                    return Some(SseLine::Other {
                        raw: std::mem::take(&mut self.buf),
                    });
                }
                return None;
            }
        };
        Some(classify(raw))
    }

    /// Unterminated trailing bytes at end-of-stream. Forward these too, or the
    /// relay would truncate a stream that ended without a final newline.
    pub(crate) fn take_tail(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
}

fn classify(raw: Vec<u8>) -> SseLine {
    let text = String::from_utf8_lossy(&raw);
    let Some(rest) = text.trim().strip_prefix("data:") else {
        return SseLine::Other { raw };
    };
    let data = rest.trim();
    let payload = if data == "[DONE]" {
        SseData::Done
    } else {
        match serde_json::from_str::<serde_json::Value>(data) {
            Ok(json) => SseData::Json(json),
            Err(_) => SseData::Raw(data.to_string()),
        }
    };
    SseLine::Data { raw, payload }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drain(reader: &mut SseLineReader) -> Vec<SseLine> {
        let mut out = Vec::new();
        while let Some(line) = reader.next_line() {
            out.push(line);
        }
        out
    }

    #[test]
    fn splits_lines_across_chunk_boundaries() {
        let mut r = SseLineReader::new();
        r.push(b"dat");
        assert!(r.next_line().is_none());
        r.push(b"a: {\"a\":1}\n");
        let lines = drain(&mut r);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0],
            SseLine::Data {
                raw: b"data: {\"a\":1}\n".to_vec(),
                payload: SseData::Json(json!({"a": 1})),
            }
        );
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut r = SseLineReader::new();
        r.push(b"data: {\"a\":1}\r\n\r\n");
        let lines = drain(&mut r);
        assert_eq!(lines.len(), 2);
        match &lines[0] {
            SseLine::Data { payload, raw } => {
                assert_eq!(payload, &SseData::Json(json!({"a": 1})));
                assert_eq!(raw, b"data: {\"a\":1}\r\n");
            }
            other => panic!("expected data line, got {other:?}"),
        }
        assert!(matches!(lines[1], SseLine::Other { .. }));
    }

    #[test]
    fn emits_done_marker() {
        let mut r = SseLineReader::new();
        r.push(b"data: [DONE]\n");
        let lines = drain(&mut r);
        assert!(matches!(
            lines[0],
            SseLine::Data {
                payload: SseData::Done,
                ..
            }
        ));
    }

    #[test]
    fn non_json_data_line_is_reported_raw_not_dropped() {
        let mut r = SseLineReader::new();
        r.push(b"data: not json at all\n");
        let lines = drain(&mut r);
        assert_eq!(
            lines[0],
            SseLine::Data {
                raw: b"data: not json at all\n".to_vec(),
                payload: SseData::Raw("not json at all".to_string()),
            }
        );
    }

    #[test]
    fn event_and_comment_lines_are_other() {
        let mut r = SseLineReader::new();
        r.push(b"event: message\n: keep-alive\n\n");
        let lines = drain(&mut r);
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|l| matches!(l, SseLine::Other { .. })));
    }

    #[test]
    fn oversized_line_without_newline_is_flushed_at_the_cap() {
        let mut r = SseLineReader::new();
        r.push(&vec![b'x'; MAX_LINE_BYTES]);
        let line = r.next_line().expect("cap should force a flush");
        assert_eq!(line.raw().len(), MAX_LINE_BYTES);
        assert!(matches!(line, SseLine::Other { .. }));
        assert!(r.next_line().is_none());
    }

    /// The property that makes inspect-and-forward safe: concatenating every
    /// emitted `raw` plus the tail reproduces the input byte for byte.
    #[test]
    fn raw_bytes_round_trip_byte_for_byte() {
        let input: &[u8] = b"event: chunk\ndata: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\r\ndata: [DONE]\n: trailing comment\ndata: unterminated";
        let mut r = SseLineReader::new();
        let mut rebuilt: Vec<u8> = Vec::new();

        // Feed one byte at a time to exercise every boundary.
        for byte in input {
            r.push(&[*byte]);
            while let Some(line) = r.next_line() {
                rebuilt.extend_from_slice(line.raw());
            }
        }
        rebuilt.extend_from_slice(&r.take_tail());

        assert_eq!(rebuilt, input);
    }

    #[test]
    fn take_tail_returns_unterminated_remainder() {
        let mut r = SseLineReader::new();
        r.push(b"data: {\"a\":1}\ndata: partial");
        let lines = drain(&mut r);
        assert_eq!(lines.len(), 1);
        assert_eq!(r.take_tail(), b"data: partial".to_vec());
        assert_eq!(r.take_tail(), Vec::<u8>::new());
    }
}
