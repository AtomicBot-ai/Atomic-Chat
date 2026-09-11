//! Parsing `sd-server`'s verbose stdout into sampling progress and a useful
//! diagnostic tail.
//!
//! sd.cpp redraws its progress bar in place: each redraw is one
//! `"\r<bar> <step>/<steps> - <speed>\x1b[K"` with a newline only on the last
//! step of a phase. So the carriage return leads a record and the
//! erase-to-end-of-line closes it; keying on CR/LF alone delivers every step
//! one redraw late.

use std::collections::VecDeque;

use crate::error::DiffusionErrorCode;

const ANSI_ERASE: &str = "\x1b[K";

/// Split raw output into complete records and the still-unterminated
/// remainder, which the caller carries into the next chunk. A record ends at
/// `\r`, `\n`, `\r\n` (one terminator, not two) or a trailing `\x1b[K`.
/// Records still contain their escapes: call [`strip_ansi`].
pub fn split_records(buf: &str) -> (Vec<String>, String) {
    let bytes = buf.as_bytes();
    let mut records = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let n = bytes.len();
    while i < n {
        let b = bytes[i];
        if b == b'\r' || b == b'\n' {
            records.push(buf[start..i].to_string());
            if b == b'\r' && i + 1 < n && bytes[i + 1] == b'\n' {
                i += 1;
            }
            i += 1;
            start = i;
            continue;
        }
        if buf[i..].starts_with(ANSI_ERASE) {
            i += ANSI_ERASE.len();
            records.push(buf[start..i].to_string());
            start = i;
            continue;
        }
        // Advance one whole UTF-8 scalar so we never slice inside a character.
        i += utf8_width(b);
    }
    (records, buf[start..].to_string())
}

fn utf8_width(first: u8) -> usize {
    match first {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        _ => 4,
    }
}

/// Drop CSI escape sequences (`ESC [ params intermediates final`).
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            // parameter bytes 0x30–0x3f, intermediate 0x20–0x2f, final 0x40–0x7e
            for next in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&next) {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Incremental UTF-8 decoding for a byte pipe: a multibyte character split
/// across two reads is held back until its continuation arrives; genuinely
/// invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Accumulator {
    pending: Vec<u8>,
}

impl Utf8Accumulator {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending.clear();
                    return out;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid_up_to]).unwrap_or(""));
                    match err.error_len() {
                        // Incomplete sequence at the end: wait for more bytes.
                        None => {
                            self.pending.drain(..valid_up_to);
                            return out;
                        }
                        Some(bad) => {
                            out.push('\u{fffd}');
                            self.pending.drain(..valid_up_to + bad);
                        }
                    }
                }
            }
        }
    }

    /// Whatever is left at EOF, decoded lossily.
    pub fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        rest
    }
}

/// `(step, total)` from a sampling-progress line such as `|====>   | 12/28 -
/// 3.5s/it` or `[ 12/ 28]`. The first `N/M` pair in the line; the caller
/// trusts it only when `M` equals the requested step count, so a stray
/// `1/100` from a loader cannot move the bar.
pub fn parse_step_line(line: &str) -> Option<(u32, u32)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let num_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let step: u32 = match line[num_start..i].parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let mut j = i;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'/' {
            continue;
        }
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let den_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if den_start == j {
            continue;
        }
        if let Ok(total) = line[den_start..j].parse::<u32>() {
            return Some((step, total));
        }
    }
    None
}

/// Lines worth keeping from a dead server's output whatever their position.
const DIAGNOSTIC_MARKERS: [&str; 8] = [
    "error",
    "abort",
    "assert",
    "unsupported",
    "not implemented",
    "out of memory",
    "failed",
    "exception",
];

/// The most useful part of the captured output, not merely its last lines.
///
/// A native abort prints its reason first and then a long backtrace, so the
/// last N lines are nothing but stack frames. Marked lines come first (in
/// order), then the last few lines for context, de-duplicated, capped at
/// `limit` characters.
pub fn diagnostic_tail(lines: &[String], keep: usize, limit: usize) -> String {
    let marked: Vec<&String> = lines
        .iter()
        .filter(|line| {
            let lower = line.to_lowercase();
            DIAGNOSTIC_MARKERS.iter().any(|m| lower.contains(m))
        })
        .collect();
    let marked_tail = &marked[marked.len().saturating_sub(keep)..];
    let context = (keep / 2).max(4);
    let context_tail = &lines[lines.len().saturating_sub(context)..];

    let mut chosen: Vec<&str> = Vec::new();
    for line in marked_tail
        .iter()
        .map(|l| l.as_str())
        .chain(context_tail.iter().map(|l| l.as_str()))
    {
        if !chosen.contains(&line) {
            chosen.push(line);
        }
    }
    let joined = chosen.join("\n");
    truncate_chars(&joined, limit)
}

pub fn diagnostic_tail_deque(lines: &VecDeque<String>) -> String {
    let lines: Vec<String> = lines.iter().cloned().collect();
    diagnostic_tail(&lines, 20, 1500)
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Why a server process died, from its exit code and captured tail.
pub fn classify_exit(tail: &str, code: Option<i32>) -> DiffusionErrorCode {
    let lower = tail.to_lowercase();
    if code == Some(137)
        || lower.contains("out of memory")
        || lower.contains("failed to allocate")
        || lower.contains("cudaerrormemoryallocation")
        || lower.contains("insufficient memory")
    {
        return DiffusionErrorCode::OutOfMemory;
    }
    DiffusionErrorCode::EngineCrashed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_split_on_cr_lf_crlf_and_erase() {
        let (records, rest) = split_records("a\rb\nc\r\nd\x1b[Ke");
        assert_eq!(records, vec!["a", "b", "c", "d\x1b[K"]);
        assert_eq!(rest, "e");
    }

    #[test]
    fn in_place_redraw_is_delivered_when_flushed() {
        // The CR leads the *next* redraw; the erase closes the current one.
        let (records, rest) = split_records("\r|==>  | 1/4 - 2.0s/it\x1b[K\r|====>| 2/4");
        assert_eq!(records, vec!["", "|==>  | 1/4 - 2.0s/it\x1b[K", ""]);
        assert_eq!(rest, "|====>| 2/4");
    }

    #[test]
    fn multibyte_characters_survive_a_chunk_boundary() {
        let text = "прогресс 1/4\n";
        let bytes = text.as_bytes();
        let mut acc = Utf8Accumulator::default();
        let mut decoded = String::new();
        // Split in the middle of the first Cyrillic letter (2 bytes each).
        decoded.push_str(&acc.push(&bytes[..1]));
        assert_eq!(decoded, "");
        decoded.push_str(&acc.push(&bytes[1..]));
        assert_eq!(decoded, text);
        assert_eq!(acc.finish(), "");

        let (records, rest) = split_records(&decoded);
        assert_eq!(records, vec!["прогресс 1/4"]);
        assert_eq!(rest, "");
    }

    #[test]
    fn invalid_bytes_become_replacement_characters() {
        let mut acc = Utf8Accumulator::default();
        let out = acc.push(&[b'a', 0xff, b'b']);
        assert_eq!(out, "a\u{fffd}b");
    }

    #[test]
    fn split_records_never_slices_inside_a_character() {
        let (records, rest) = split_records("é\x1b[Kü");
        assert_eq!(records, vec!["é\x1b[K"]);
        assert_eq!(rest, "ü");
    }

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\x1b[32mok\x1b[0m done\x1b[K"), "ok done");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn step_lines_parse_in_every_observed_shape() {
        assert_eq!(
            parse_step_line("|====>    | 12/28 - 3.52s/it"),
            Some((12, 28))
        );
        assert_eq!(parse_step_line("[ 12/ 28]"), Some((12, 28)));
        assert_eq!(
            parse_step_line("sampling: 50%|.....| 14/28"),
            Some((14, 28))
        );
        assert_eq!(parse_step_line("4/4"), Some((4, 4)));
        assert_eq!(parse_step_line("loading model from file"), None);
        assert_eq!(parse_step_line("size 1024x1024"), None);
        assert_eq!(parse_step_line("3.5s/it"), None);
    }

    #[test]
    fn diagnostic_tail_puts_marked_lines_first() {
        let mut lines: Vec<String> = Vec::new();
        lines.push("ggml_metal: error: unsupported op 'RMS_NORM'".into());
        lines.push("GGML_ABORT".into());
        for i in 0..30 {
            lines.push(format!("frame #{i} 0x{i:08x}"));
        }
        let tail = diagnostic_tail(&lines, 20, 1500);
        let first_lines: Vec<&str> = tail.lines().collect();
        assert_eq!(
            first_lines[0],
            "ggml_metal: error: unsupported op 'RMS_NORM'"
        );
        assert_eq!(first_lines[1], "GGML_ABORT");
        // Context: the last max(keep/2, 4) = 10 lines follow, de-duplicated.
        assert_eq!(first_lines.len(), 12);
        assert_eq!(*first_lines.last().unwrap(), "frame #29 0x0000001d");
    }

    #[test]
    fn diagnostic_tail_is_capped_and_deduplicated() {
        let lines: Vec<String> = vec!["error x".into(); 3];
        let tail = diagnostic_tail(&lines, 20, 1500);
        assert_eq!(tail, "error x");
        let long: Vec<String> = vec!["a".repeat(2000)];
        assert_eq!(diagnostic_tail(&long, 20, 100).len(), 100);
    }

    #[test]
    fn exit_classification() {
        assert_eq!(
            classify_exit("", Some(137)),
            DiffusionErrorCode::OutOfMemory
        );
        assert_eq!(
            classify_exit(
                "ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate",
                Some(1)
            ),
            DiffusionErrorCode::OutOfMemory
        );
        assert_eq!(
            classify_exit("CUDA error: Out Of Memory", Some(1)),
            DiffusionErrorCode::OutOfMemory
        );
        assert_eq!(
            classify_exit("unsupported op 'RMS_NORM'\nGGML_ABORT", Some(-6)),
            DiffusionErrorCode::EngineCrashed
        );
        assert_eq!(classify_exit("", None), DiffusionErrorCode::EngineCrashed);
    }
}
