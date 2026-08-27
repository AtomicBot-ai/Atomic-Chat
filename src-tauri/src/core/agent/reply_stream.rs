//! Incremental extraction of streamable text from a constrained completion.
//!
//! The agent's completions are a JSON array of tool calls, so the final answer
//! — `reply.args.text` — is buried inside a JSON string and would otherwise
//! reach the user only when the whole completion has been parsed. This scanner
//! consumes the raw content stream character by character and recovers, live:
//!
//! - the reasoning prelude (`<think>…</think>` or a profile's native channel),
//!   which llama.cpp keeps in `content` when the tags are preserved tokens;
//! - the unescaped `reply.args.text` value, when and only when the array's
//!   first call is `reply` (the grammar pins key order to
//!   `{"tool": …, "args": …}` and `reply`'s args to `{"text": …}`).
//!
//! The scanner is strictly best-effort: any divergence from the expected shape
//! stops streaming for the rest of the completion. Correctness never depends
//! on it — the parsed completion remains authoritative and the terminal
//! `AssistantReply` event replaces whatever was streamed.

/// Decoded output recovered from one fed chunk.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FeedOutput {
    pub reasoning: String,
    pub reply: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Matching the prelude's open tag (only when a prelude is configured).
    PreludeOpen { matched: usize },
    /// Inside the prelude body; `close_matched` tracks a partial close tag.
    PreludeBody { close_matched: usize },
    /// Matching one literal JSON token from the fixed pattern.
    Token { index: usize, offset: usize },
    /// Reading the tool-name string (first array element).
    ToolName,
    /// Streaming the unescaped `reply.args.text` value.
    ReplyText,
    /// Shape diverged or the text finished; ignore the rest of the stream.
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Escape {
    None,
    /// Saw `\`, deciding on the next character.
    Start,
    /// Collecting the 4 hex digits of `\uXXXX`.
    Unicode,
}

/// The literal tokens between the array start and the streamed text value,
/// with `ws` allowed in front of each: `[ { "tool" : <name> , "args" : { "text" : "…`.
/// The tool-name string and the final opening quote get dedicated states.
const TOKENS_BEFORE_NAME: &[&str] = &["[", "{", "\"tool\"", ":", "\""];
const TOKENS_AFTER_NAME: &[&str] = &[",", "\"args\"", ":", "{", "\"text\"", ":", "\""];

pub struct ReplyStreamScanner {
    state: State,
    /// `Some` while matching `TOKENS_BEFORE_NAME`, `None` after the name.
    before_name: bool,
    prelude: Option<(&'static str, &'static str)>,
    tool_name: String,
    escape: Escape,
    unicode_digits: String,
    pending_high_surrogate: Option<u16>,
    streamed_reply: String,
}

impl ReplyStreamScanner {
    /// `prelude` is the reasoning tag pair the grammar emits ahead of the
    /// array, when the turn has one (`<think>`/`</think>` or a native channel).
    pub fn new(prelude: Option<(&'static str, &'static str)>) -> Self {
        Self {
            state: match prelude {
                Some(_) => State::PreludeOpen { matched: 0 },
                None => State::Token {
                    index: 0,
                    offset: 0,
                },
            },
            before_name: true,
            prelude,
            tool_name: String::new(),
            escape: Escape::None,
            unicode_digits: String::new(),
            pending_high_surrogate: None,
            streamed_reply: String::new(),
        }
    }

    /// Everything streamed as `reply.args.text` so far, already unescaped.
    pub fn streamed_reply(&self) -> &str {
        &self.streamed_reply
    }

    pub fn feed(&mut self, delta: &str) -> FeedOutput {
        let mut output = FeedOutput::default();
        for ch in delta.chars() {
            self.feed_char(ch, &mut output);
        }
        output
    }

    fn feed_char(&mut self, ch: char, output: &mut FeedOutput) {
        match self.state {
            State::Done => {}
            State::PreludeOpen { matched } => {
                let open = self.prelude.expect("prelude state requires tags").0;
                let expected = open[matched..].chars().next();
                if expected == Some(ch) {
                    let matched = matched + ch.len_utf8();
                    self.state = if matched >= open.len() {
                        State::PreludeBody { close_matched: 0 }
                    } else {
                        State::PreludeOpen { matched }
                    };
                } else {
                    // Not a prelude after all (e.g. the model skipped an
                    // optional channel). Replay what we swallowed as JSON.
                    self.state = State::Token {
                        index: 0,
                        offset: 0,
                    };
                    let swallowed = open[..matched].to_owned();
                    for prior in swallowed.chars() {
                        self.feed_char(prior, output);
                    }
                    self.feed_char(ch, output);
                }
            }
            State::PreludeBody { close_matched } => {
                let close = self.prelude.expect("prelude state requires tags").1;
                let expected = close[close_matched..].chars().next();
                if expected == Some(ch) {
                    let close_matched = close_matched + ch.len_utf8();
                    if close_matched >= close.len() {
                        self.state = State::Token {
                            index: 0,
                            offset: 0,
                        };
                    } else {
                        self.state = State::PreludeBody { close_matched };
                    }
                } else {
                    // A partial close-tag match turned out to be body text.
                    output.reasoning.push_str(&close[..close_matched]);
                    self.state = State::PreludeBody { close_matched: 0 };
                    if close.starts_with(ch) {
                        self.state = State::PreludeBody {
                            close_matched: ch.len_utf8(),
                        };
                    } else {
                        output.reasoning.push(ch);
                    }
                }
            }
            State::Token { index, offset } => {
                let tokens = if self.before_name {
                    TOKENS_BEFORE_NAME
                } else {
                    TOKENS_AFTER_NAME
                };
                let token = tokens[index];
                if offset == 0 && matches!(ch, ' ' | '\t' | '\n' | '\r') {
                    return; // `ws` before any token
                }
                if token[offset..].chars().next() == Some(ch) {
                    let offset = offset + ch.len_utf8();
                    if offset < token.len() {
                        self.state = State::Token { index, offset };
                    } else if index + 1 < tokens.len() {
                        self.state = State::Token {
                            index: index + 1,
                            offset: 0,
                        };
                    } else if self.before_name {
                        self.state = State::ToolName;
                    } else {
                        self.state = State::ReplyText;
                    }
                } else {
                    self.state = State::Done;
                }
            }
            State::ToolName => {
                // Tool names contain no escapes worth handling; a `\` means
                // this is not a plain name, so stop streaming.
                if ch == '"' {
                    if self.tool_name == "reply" {
                        self.before_name = false;
                        self.state = State::Token {
                            index: 0,
                            offset: 0,
                        };
                    } else {
                        self.state = State::Done;
                    }
                } else if ch == '\\' {
                    self.state = State::Done;
                } else {
                    self.tool_name.push(ch);
                }
            }
            State::ReplyText => self.feed_reply_char(ch, output),
        }
    }

    fn feed_reply_char(&mut self, ch: char, output: &mut FeedOutput) {
        match self.escape {
            Escape::None => match ch {
                '"' => self.state = State::Done,
                '\\' => self.escape = Escape::Start,
                _ => self.emit_reply(ch, output),
            },
            Escape::Start => {
                self.escape = Escape::None;
                match ch {
                    '"' => self.emit_reply('"', output),
                    '\\' => self.emit_reply('\\', output),
                    '/' => self.emit_reply('/', output),
                    'b' => self.emit_reply('\u{0008}', output),
                    'f' => self.emit_reply('\u{000C}', output),
                    'n' => self.emit_reply('\n', output),
                    'r' => self.emit_reply('\r', output),
                    't' => self.emit_reply('\t', output),
                    'u' => {
                        self.escape = Escape::Unicode;
                        self.unicode_digits.clear();
                    }
                    _ => self.state = State::Done,
                }
            }
            Escape::Unicode => {
                if !ch.is_ascii_hexdigit() {
                    self.state = State::Done;
                    return;
                }
                self.unicode_digits.push(ch);
                if self.unicode_digits.len() == 4 {
                    self.escape = Escape::None;
                    let Ok(unit) = u16::from_str_radix(&self.unicode_digits, 16) else {
                        self.state = State::Done;
                        return;
                    };
                    match (self.pending_high_surrogate.take(), unit) {
                        (None, 0xD800..=0xDBFF) => {
                            self.pending_high_surrogate = Some(unit);
                        }
                        (None, _) => match char::from_u32(u32::from(unit)) {
                            Some(decoded) => self.emit_reply(decoded, output),
                            None => self.state = State::Done,
                        },
                        (Some(high), 0xDC00..=0xDFFF) => {
                            let combined = 0x10000
                                + ((u32::from(high) - 0xD800) << 10)
                                + (u32::from(unit) - 0xDC00);
                            match char::from_u32(combined) {
                                Some(decoded) => self.emit_reply(decoded, output),
                                None => self.state = State::Done,
                            }
                        }
                        (Some(_), _) => self.state = State::Done,
                    }
                }
            }
        }
    }

    fn emit_reply(&mut self, ch: char, output: &mut FeedOutput) {
        // A lone high surrogate must pair with the next escape; anything else
        // in between is malformed JSON, so stop rather than guess.
        if self.pending_high_surrogate.is_some() {
            self.state = State::Done;
            return;
        }
        self.streamed_reply.push(ch);
        output.reply.push(ch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(scanner: &mut ReplyStreamScanner, chunks: &[&str]) -> FeedOutput {
        let mut combined = FeedOutput::default();
        for chunk in chunks {
            let output = scanner.feed(chunk);
            combined.reasoning.push_str(&output.reasoning);
            combined.reply.push_str(&output.reply);
        }
        combined
    }

    #[test]
    fn streams_reply_text_from_a_plain_array() {
        let mut scanner = ReplyStreamScanner::new(None);
        let output = feed_all(
            &mut scanner,
            &[r#"[{"tool": "re"#, r#"ply", "args": {"te"#, r#"xt": "Hello, "#, r#"world"}}]"#],
        );
        assert_eq!(output.reply, "Hello, world");
        assert_eq!(scanner.streamed_reply(), "Hello, world");
        assert!(output.reasoning.is_empty());
    }

    #[test]
    fn decodes_escapes_and_unicode() {
        let mut scanner = ReplyStreamScanner::new(None);
        let output =
            scanner.feed(r#"[{"tool":"reply","args":{"text":"a\nb\"cé😀"}}]"#);
        assert_eq!(output.reply, "a\nb\"cé😀");
    }

    #[test]
    fn does_not_stream_other_tools() {
        let mut scanner = ReplyStreamScanner::new(None);
        let output = scanner.feed(r#"[{"tool":"os.fs.read","args":{"path":"x"}}]"#);
        assert_eq!(output.reply, "");
    }

    #[test]
    fn streams_think_prelude_as_reasoning() {
        let mut scanner = ReplyStreamScanner::new(Some(("<think>", "</think>")));
        let output = feed_all(
            &mut scanner,
            &["<think>let me <", "/ think about it</th", r#"ink>[{"tool":"reply","args":{"text":"ok"}}]"#],
        );
        assert_eq!(output.reasoning, "let me </ think about it");
        assert_eq!(output.reply, "ok");
    }

    #[test]
    fn replays_a_missing_prelude_as_json() {
        let mut scanner = ReplyStreamScanner::new(Some(("<think>", "</think>")));
        let output = scanner.feed(r#"[{"tool":"reply","args":{"text":"no think"}}]"#);
        assert_eq!(output.reply, "no think");
    }

    #[test]
    fn tolerates_whitespace_between_tokens() {
        let mut scanner = ReplyStreamScanner::new(None);
        let output = scanner.feed("[ { \"tool\" : \"reply\" ,\n\"args\" : { \"text\" : \"hi\" } } ]");
        assert_eq!(output.reply, "hi");
    }

    #[test]
    fn stops_on_shape_divergence_without_panicking() {
        let mut scanner = ReplyStreamScanner::new(None);
        let output = scanner.feed(r#"{"not":"an array"}"#);
        assert_eq!(output.reply, "");
        assert_eq!(output.reasoning, "");
    }
}
