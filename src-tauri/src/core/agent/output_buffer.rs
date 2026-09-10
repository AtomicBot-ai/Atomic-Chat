//! Bounded, terminal-aware output buffer for PTY-backed processes.
//!
//! A PTY hands us raw terminal bytes, not a log file: colour escapes, cursor
//! moves, and — critically — carriage returns. `cargo`, `npm` and `pip` all
//! draw progress by rewriting the current line with `\r`, so a naive byte sink
//! turns one progress bar into hundreds of near-identical lines. Feeding that
//! to the model burns context and trips [`super::loop_guard`], which is exactly
//! what it should do given the input, so the fix belongs here.
//!
//! This buffer renders the stream the way a terminal would — minus the parts a
//! log reader does not need. It keeps *scrollback* (a bounded ring of committed
//! lines) rather than a fixed screen, because the agent reads build output far
//! more often than it drives a full-screen TUI. If interactive TUI support ever
//! lands, `alacritty_terminal` replaces this module wholesale.
//!
//! Reads are **forward-paging**: [`OutputBuffer::read_from`] takes the cursor
//! returned by the previous read, so successive `os.proc.read` calls walk the
//! stream without re-sending what the model already saw.

use std::collections::VecDeque;

/// Total rendered bytes retained before the oldest lines are evicted.
pub const DEFAULT_CAPACITY_BYTES: usize = 256 * 1024;

/// Ceiling on a single rendered line. Minified bundles and accidental binary
/// dumps arrive as one enormous "line"; without this the ring's byte accounting
/// is dominated by a single entry.
pub const MAX_LINE_CHARS: usize = 8 * 1024;

/// Longest incomplete UTF-8 tail worth carrying to the next chunk. A valid
/// sequence is at most 4 bytes, so anything longer is a decoding desync.
const MAX_PENDING_BYTES: usize = 4;

/// Where the escape-sequence scanner is between chunks. Escapes routinely
/// straddle a read boundary, so this has to survive across `push_bytes` calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscapeState {
    Normal,
    /// Saw ESC.
    Escape,
    /// Inside `ESC [ … final`.
    Csi,
    /// Inside a string-terminated sequence (OSC/DCS/SOS/PM/APC).
    String,
    /// Saw ESC inside a string sequence; `\` completes the ST terminator.
    StringEscape,
}

/// One forward page of the buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BufferSlice {
    /// Rendered text: committed lines joined by `\n`, plus the in-progress
    /// line when one exists.
    pub text: String,
    /// Cursor to pass to the next read.
    pub next_cursor: u64,
    /// Committed lines evicted by the ring since the process started.
    pub dropped_lines: u64,
    /// The requested cursor pointed at evicted content, or `max_chars` cut the
    /// page short. Either way the caller did not receive everything it asked for.
    pub truncated: bool,
    /// The tail of `text` is a line the process has not terminated yet (an
    /// unanswered prompt, a live progress bar). It may reappear in the next
    /// read, since `next_cursor` only advances past committed lines.
    pub has_partial: bool,
}

#[derive(Debug)]
pub struct OutputBuffer {
    /// Committed lines, oldest first.
    lines: VecDeque<String>,
    /// The line being written, as chars so `\r` can seek by index.
    current: Vec<char>,
    /// Write position within `current`.
    cursor: usize,
    /// Absolute index of `lines.front()`.
    first_line_index: u64,
    /// Absolute index just past the newest committed line.
    committed_lines: u64,
    /// Rendered bytes held in `lines`, including one byte per newline.
    bytes: usize,
    capacity: usize,
    dropped_lines: u64,
    /// Incomplete UTF-8 tail carried to the next chunk.
    pending: Vec<u8>,
    state: EscapeState,
}

impl Default for OutputBuffer {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY_BYTES)
    }
}

impl OutputBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            lines: VecDeque::new(),
            current: Vec::new(),
            cursor: 0,
            first_line_index: 0,
            committed_lines: 0,
            bytes: 0,
            capacity: capacity.max(1024),
            dropped_lines: 0,
            pending: Vec::new(),
            state: EscapeState::Normal,
        }
    }

    /// Feed raw PTY bytes. Safe to call with arbitrary chunk boundaries: both
    /// partial UTF-8 sequences and partial escape sequences carry over.
    pub fn push_bytes(&mut self, chunk: &[u8]) {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(chunk);
        let mut start = 0usize;
        loop {
            match std::str::from_utf8(&buf[start..]) {
                Ok(text) => {
                    let owned = text.to_owned();
                    self.push_str(&owned);
                    start = buf.len();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        let owned =
                            String::from_utf8_lossy(&buf[start..start + valid_up_to]).into_owned();
                        self.push_str(&owned);
                        start += valid_up_to;
                    }
                    match error.error_len() {
                        // Truncated sequence at the chunk boundary: keep it.
                        None => break,
                        Some(len) => {
                            self.consume(char::REPLACEMENT_CHARACTER);
                            start += len;
                        }
                    }
                }
            }
        }
        self.pending = buf[start..].to_vec();
        if self.pending.len() > MAX_PENDING_BYTES {
            // Not a UTF-8 stream. Drop the desynced tail rather than growing.
            self.pending.clear();
        }
    }

    fn push_str(&mut self, text: &str) {
        for character in text.chars() {
            self.consume(character);
        }
    }

    fn consume(&mut self, character: char) {
        match self.state {
            EscapeState::Normal => self.consume_normal(character),
            EscapeState::Escape => {
                self.state = match character {
                    '[' => EscapeState::Csi,
                    // OSC, DCS, SOS, PM, APC all run until a string terminator.
                    ']' | 'P' | 'X' | '^' | '_' => EscapeState::String,
                    // Anything else is a complete two-character escape.
                    _ => EscapeState::Normal,
                };
            }
            EscapeState::Csi => {
                // Parameter and intermediate bytes continue the sequence; a
                // byte in 0x40..=0x7e is the final byte.
                if matches!(character, '\u{40}'..='\u{7e}') {
                    self.state = EscapeState::Normal;
                }
            }
            EscapeState::String => match character {
                '\u{07}' => self.state = EscapeState::Normal,
                '\u{1b}' => self.state = EscapeState::StringEscape,
                _ => {}
            },
            EscapeState::StringEscape => match character {
                '\\' => self.state = EscapeState::Normal,
                '\u{1b}' => {}
                _ => self.state = EscapeState::String,
            },
        }
    }

    fn consume_normal(&mut self, character: char) {
        match character {
            '\u{1b}' => self.state = EscapeState::Escape,
            '\n' => self.commit_line(),
            // Carriage return seeks to column zero; whatever follows overwrites
            // the line in place. This is the progress-bar case.
            '\r' => self.cursor = 0,
            '\u{08}' => self.cursor = self.cursor.saturating_sub(1),
            '\t' => self.write(character),
            // Remaining C0 controls and DEL have no place in a rendered log.
            control if (control as u32) < 0x20 || control == '\u{7f}' => {}
            printable => self.write(printable),
        }
    }

    fn write(&mut self, character: char) {
        if self.cursor < self.current.len() {
            self.current[self.cursor] = character;
            self.cursor += 1;
        } else if self.current.len() < MAX_LINE_CHARS {
            self.current.push(character);
            self.cursor = self.current.len();
        }
        // Past MAX_LINE_CHARS the character is dropped and the cursor stays put,
        // so an unbounded line cannot outgrow the ring.
    }

    fn commit_line(&mut self) {
        let line: String = self.current.iter().collect();
        self.current.clear();
        self.cursor = 0;
        self.bytes += line.len() + 1;
        self.lines.push_back(line);
        self.committed_lines += 1;
        self.evict();
    }

    fn evict(&mut self) {
        while self.bytes > self.capacity && self.lines.len() > 1 {
            if let Some(line) = self.lines.pop_front() {
                self.bytes = self.bytes.saturating_sub(line.len() + 1);
                self.first_line_index += 1;
                self.dropped_lines += 1;
            }
        }
    }

    /// Absolute cursor just past the newest committed line.
    pub fn cursor(&self) -> u64 {
        self.committed_lines
    }

    pub fn dropped_lines(&self) -> u64 {
        self.dropped_lines
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty() && self.current.is_empty()
    }

    /// Read forward from `cursor`, returning at most `max_chars` of text.
    ///
    /// A `cursor` behind the ring window silently resumes at the oldest retained
    /// line and sets `truncated`; the caller learns how much it missed from
    /// `dropped_lines`.
    pub fn read_from(&self, cursor: u64, max_chars: usize) -> BufferSlice {
        let mut truncated = cursor < self.first_line_index;
        let start = cursor.max(self.first_line_index).min(self.committed_lines);
        let offset = (start - self.first_line_index) as usize;

        let mut text = String::new();
        let mut next_cursor = start;
        for line in self.lines.iter().skip(offset) {
            // +1 for the newline this line will contribute.
            if !text.is_empty() && text.chars().count() + line.chars().count() + 1 > max_chars {
                truncated = true;
                break;
            }
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(line);
            next_cursor += 1;
            if text.chars().count() >= max_chars {
                truncated = true;
                break;
            }
        }

        // The in-progress line is the live tail: an unanswered prompt never
        // gets a newline, so withholding it would hide exactly the output the
        // model is waiting on.
        let mut has_partial = false;
        if next_cursor == self.committed_lines && !self.current.is_empty() {
            let partial: String = self.current.iter().collect();
            if text.chars().count() + partial.chars().count() + 1 <= max_chars {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&partial);
                has_partial = true;
            } else {
                truncated = true;
            }
        }

        BufferSlice {
            text,
            next_cursor,
            dropped_lines: self.dropped_lines,
            truncated,
            has_partial,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(buffer: &OutputBuffer) -> String {
        buffer.read_from(0, usize::MAX).text
    }

    #[test]
    fn commits_plain_lines() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"first\nsecond\n");
        assert_eq!(drain(&buffer), "first\nsecond");
        assert_eq!(buffer.cursor(), 2);
    }

    #[test]
    fn exposes_the_unterminated_tail() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"done\nPassword: ");
        let slice = buffer.read_from(0, usize::MAX);
        assert_eq!(slice.text, "done\nPassword: ");
        assert!(slice.has_partial);
        // The cursor stays behind the partial line, so it reappears until the
        // process terminates it.
        assert_eq!(slice.next_cursor, 1);
    }

    #[test]
    fn carriage_return_overwrites_in_place() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"  1%\r 50%\r100%\n");
        assert_eq!(drain(&buffer), "100%");
        assert_eq!(buffer.cursor(), 1);
    }

    #[test]
    fn carriage_return_keeps_the_uncovered_tail() {
        // A shorter rewrite does not erase what it did not cover — this is what
        // a real terminal does, and why "100%]" can trail an old suffix.
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"building foo\rdone\n");
        assert_eq!(drain(&buffer), "doneding foo");
    }

    #[test]
    fn strips_csi_colour_sequences() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"\x1b[31merror\x1b[0m: boom\n");
        assert_eq!(drain(&buffer), "error: boom");
    }

    #[test]
    fn strips_osc_title_sequences() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"\x1b]0;window title\x07visible\n");
        assert_eq!(drain(&buffer), "visible");
        buffer.push_bytes(b"\x1b]0;st terminated\x1b\\also visible\n");
        assert_eq!(drain(&buffer), "visible\nalso visible");
    }

    #[test]
    fn escape_sequences_survive_chunk_boundaries() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"\x1b[");
        buffer.push_bytes(b"32mgreen\x1b");
        buffer.push_bytes(b"[0m\n");
        assert_eq!(drain(&buffer), "green");
    }

    #[test]
    fn utf8_survives_chunk_boundaries() {
        let mut buffer = OutputBuffer::default();
        let text = "привет".as_bytes();
        let (head, tail) = text.split_at(5);
        buffer.push_bytes(head);
        buffer.push_bytes(tail);
        buffer.push_bytes(b"\n");
        assert_eq!(drain(&buffer), "привет");
    }

    #[test]
    fn invalid_bytes_become_replacement_characters() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(&[b'a', 0xff, b'b', b'\n']);
        assert_eq!(drain(&buffer), "a\u{fffd}b");
        assert!(buffer.pending.is_empty());
    }

    #[test]
    fn backspace_moves_the_cursor_back() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"abc\x08\x08XY\n");
        assert_eq!(drain(&buffer), "aXY");
    }

    #[test]
    fn forward_paging_does_not_repeat_committed_lines() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"one\ntwo\n");
        let first = buffer.read_from(0, usize::MAX);
        assert_eq!(first.text, "one\ntwo");
        buffer.push_bytes(b"three\n");
        let second = buffer.read_from(first.next_cursor, usize::MAX);
        assert_eq!(second.text, "three");
        assert!(!second.truncated);
    }

    #[test]
    fn max_chars_pages_forward_rather_than_tailing() {
        let mut buffer = OutputBuffer::default();
        buffer.push_bytes(b"aaaa\nbbbb\ncccc\n");
        let first = buffer.read_from(0, 6);
        assert_eq!(first.text, "aaaa");
        assert!(first.truncated);
        let second = buffer.read_from(first.next_cursor, 6);
        assert_eq!(second.text, "bbbb");
    }

    #[test]
    fn ring_evicts_oldest_lines_and_reports_the_loss() {
        let mut buffer = OutputBuffer::new(1024);
        for index in 0..500 {
            buffer.push_bytes(format!("line {index} padding padding padding\n").as_bytes());
        }
        assert!(buffer.dropped_lines() > 0);
        let slice = buffer.read_from(0, usize::MAX);
        // Reading from a cursor the ring has passed resumes at the oldest line
        // still held, and says so.
        assert!(slice.truncated);
        assert_eq!(slice.dropped_lines, buffer.dropped_lines());
        assert!(slice.text.contains("line 499"));
        assert!(!slice.text.contains("line 0 "));
    }

    #[test]
    fn a_single_unbounded_line_cannot_outgrow_the_ring() {
        let mut buffer = OutputBuffer::new(2048);
        buffer.push_bytes(&vec![b'x'; MAX_LINE_CHARS * 4]);
        buffer.push_bytes(b"\n");
        let slice = buffer.read_from(0, usize::MAX);
        assert_eq!(slice.text.chars().count(), MAX_LINE_CHARS);
    }

    #[test]
    fn non_utf8_stream_does_not_grow_pending() {
        let mut buffer = OutputBuffer::default();
        for _ in 0..100 {
            buffer.push_bytes(&[0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0xc3]);
        }
        assert!(buffer.pending.len() <= MAX_PENDING_BYTES);
    }
}
