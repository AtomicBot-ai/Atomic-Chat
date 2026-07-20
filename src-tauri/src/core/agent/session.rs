use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::compressor::{compress_tool_result, should_compress_tool};
use super::prompt::ToolTier;
use super::tools::tool_view::{descriptor_for, LOADED_TOOLS_CAP};
use super::types::{ToolCallPayload, ToolOutcome, ToolStatus};
use crate::core::threads::utils::{get_data_dir, get_thread_dir};

const SESSION_VERSION: u32 = 1;
const SESSION_FILE_NAME: &str = "agent-session.json";
const MAX_SESSION_FILE_BYTES: u64 = 512 * 1024;
const MAX_TURNS: usize = 96;
const MAX_USER_TEXT_CHARS: usize = 8_000;
const MAX_REPLY_TEXT_CHARS: usize = 12_000;
const MAX_TOOL_SUMMARY_CHARS: usize = 1_200;
const MAX_CONVERSATION_CHARS: usize = 32_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentSessionTurn {
    User {
        text: String,
    },
    AssistantToolCall {
        tool: String,
        #[serde(skip)]
        args: Option<serde_json::Value>,
    },
    ToolResult {
        tool: String,
        status: ToolStatus,
        summary: String,
    },
    AssistantReply {
        text: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentSessionState {
    pub version: u32,
    pub session_id: String,
    pub turn_count: u64,
    pub turns: Vec<AgentSessionTurn>,
    pub loaded_tools: Vec<String>,
}

impl AgentSessionState {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            version: SESSION_VERSION,
            session_id: session_id.into(),
            turn_count: 0,
            turns: Vec::new(),
            loaded_tools: Vec::new(),
        }
    }

    pub fn push_user(&mut self, text: &str) {
        self.push_turn(AgentSessionTurn::User {
            text: truncate_chars(text, MAX_USER_TEXT_CHARS),
        });
    }

    pub fn push_tool_observations(&mut self, calls: &[ToolCallPayload], outcomes: &[ToolOutcome]) {
        for (call, outcome) in calls.iter().zip(outcomes) {
            let prompt_summary = if should_compress_tool(&call.tool) {
                compress_tool_result(&call.tool, outcome.status, &outcome.summary).summary
            } else {
                outcome.summary.clone()
            };
            self.push_turn(AgentSessionTurn::AssistantToolCall {
                tool: call.tool.clone(),
                args: Some(call.args.clone()),
            });
            self.push_turn(AgentSessionTurn::ToolResult {
                tool: call.tool.clone(),
                status: outcome.status,
                summary: truncate_chars(&prompt_summary, MAX_TOOL_SUMMARY_CHARS),
            });
        }
    }

    pub fn push_reply(&mut self, text: &str) {
        self.push_turn(AgentSessionTurn::AssistantReply {
            text: truncate_chars(text, MAX_REPLY_TEXT_CHARS),
        });
    }

    pub fn finish_turn(&mut self) {
        for turn in &mut self.turns {
            if let AgentSessionTurn::AssistantToolCall { args, .. } = turn {
                *args = None;
            }
        }
        self.turn_count = self.turn_count.saturating_add(1);
    }

    pub fn set_loaded_tools(&mut self, names: Vec<String>) {
        self.loaded_tools = names.into_iter().take(LOADED_TOOLS_CAP).collect();
    }

    pub fn render_conversation(&self) -> String {
        let rendered = self.turns.iter().map(render_turn).collect::<Vec<_>>();
        let mut selected = Vec::new();
        let mut used = 0usize;
        for turn in rendered.into_iter().rev() {
            let cost = turn.chars().count() + usize::from(!selected.is_empty());
            if !selected.is_empty() && used + cost > MAX_CONVERSATION_CHARS {
                break;
            }
            used += cost;
            selected.push(turn);
        }
        selected.reverse();
        selected.join("\n")
    }

    fn push_turn(&mut self, turn: AgentSessionTurn) {
        self.turns.push(turn);
        if self.turns.len() > MAX_TURNS {
            self.turns.drain(..self.turns.len() - MAX_TURNS);
        }
    }

    fn validate(&self, expected_session_id: &str) -> Result<(), String> {
        if self.version != SESSION_VERSION {
            return Err(format!(
                "Unsupported agent session version {}",
                self.version
            ));
        }
        if self.session_id != expected_session_id {
            return Err("Agent session id does not match its thread directory".into());
        }
        if self.turns.len() > MAX_TURNS {
            return Err("Agent session contains too many turns".into());
        }
        if self.loaded_tools.len() > LOADED_TOOLS_CAP
            || self.loaded_tools.iter().any(|name| {
                descriptor_for(name).is_none_or(|descriptor| descriptor.tier != ToolTier::Rare)
            })
        {
            return Err("Agent session contains invalid loaded tools".into());
        }
        for turn in &self.turns {
            match turn {
                AgentSessionTurn::User { text } if text.chars().count() > MAX_USER_TEXT_CHARS => {
                    return Err("Agent session contains an oversized user turn".into());
                }
                AgentSessionTurn::AssistantReply { text }
                    if text.chars().count() > MAX_REPLY_TEXT_CHARS =>
                {
                    return Err("Agent session contains an oversized assistant reply".into());
                }
                AgentSessionTurn::ToolResult { summary, .. }
                    if summary.chars().count() > MAX_TOOL_SUMMARY_CHARS =>
                {
                    return Err("Agent session contains an oversized tool result".into());
                }
                AgentSessionTurn::AssistantToolCall { tool, .. }
                | AgentSessionTurn::ToolResult { tool, .. }
                    if descriptor_for(tool).is_none() =>
                {
                    return Err("Agent session contains an unknown tool".into());
                }
                _ => {}
            }
        }
        Ok(())
    }
}

pub fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("session_id must be a non-empty path component".into());
    }
    let path = Path::new(session_id);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("session_id must be a safe single path component".into());
    }
    Ok(())
}

pub async fn load_session(data_dir: &Path, session_id: &str) -> Result<AgentSessionState, String> {
    let path = session_file_path(data_dir, session_id).await?;
    match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.len() > MAX_SESSION_FILE_BYTES => {
            return Err("Agent session file is too large".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(AgentSessionState::new(session_id));
        }
        Err(error) => return Err(format!("Could not inspect agent session: {error}")),
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Could not read agent session: {error}"))?;
    let state: AgentSessionState = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not parse agent session: {error}"))?;
    state.validate(session_id)?;
    Ok(state)
}

pub async fn save_session(data_dir: &Path, state: &AgentSessionState) -> Result<(), String> {
    state.validate(&state.session_id)?;
    let path = session_file_path(data_dir, &state.session_id).await?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Could not serialize agent session: {error}"))?;
    if bytes.len() as u64 > MAX_SESSION_FILE_BYTES {
        return Err("Agent session file would exceed its size limit".into());
    }
    let temp_path = temporary_path(&path);
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options
        .open(&temp_path)
        .await
        .map_err(|error| format!("Could not create agent session temp file: {error}"))?;
    use tokio::io::AsyncWriteExt;
    file.write_all(&bytes)
        .await
        .map_err(|error| format!("Could not write agent session: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("Could not sync agent session: {error}"))?;
    drop(file);
    atomic_replace(&temp_path, &path)
        .await
        .map_err(|error| format!("Could not replace agent session: {error}"))
}

async fn session_file_path(data_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    validate_session_id(session_id)?;
    let thread_dir = get_thread_dir(data_dir, session_id);
    let threads_root = tokio::fs::canonicalize(get_data_dir(data_dir))
        .await
        .map_err(|error| format!("Agent threads directory does not exist: {error}"))?;
    let canonical_thread_dir = tokio::fs::canonicalize(&thread_dir)
        .await
        .map_err(|error| format!("Agent thread directory does not exist: {error}"))?;
    if canonical_thread_dir.parent() != Some(threads_root.as_path()) {
        return Err("Agent thread directory escapes the threads root".into());
    }
    let metadata = tokio::fs::metadata(&canonical_thread_dir)
        .await
        .map_err(|error| format!("Could not inspect agent thread directory: {error}"))?;
    if !metadata.is_dir() {
        return Err("Agent thread path is not a directory".into());
    }
    Ok(canonical_thread_dir.join(SESSION_FILE_NAME))
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_file_name(format!("{SESSION_FILE_NAME}.{}.tmp", uuid::Uuid::new_v4()))
}

#[cfg(not(windows))]
async fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    tokio::fs::rename(source, destination).await
}

#[cfg(windows)]
async fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn render_turn(turn: &AgentSessionTurn) -> String {
    match turn {
        AgentSessionTurn::User { text } => format!("USER: {text}"),
        AgentSessionTurn::AssistantToolCall { tool, args } => {
            let call = args.as_ref().map_or_else(
                || serde_json::json!({"tool": tool}),
                |args| serde_json::json!({"tool": tool, "args": args}),
            );
            format!(
                "ASSISTANT_TOOL_CALL: {}",
                serde_json::to_string(&call).unwrap_or_else(|_| "{}".into())
            )
        }
        AgentSessionTurn::ToolResult {
            status, summary, ..
        } => format!("TOOL_RESULT: status={status:?}; {summary}"),
        AgentSessionTurn::AssistantReply { text } => format!("ASSISTANT: {text}"),
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    let mut result = value
        .chars()
        .take(max_chars.saturating_sub(12))
        .collect::<String>();
    result.push_str("[truncated]");
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct SessionFixture {
        data_dir: PathBuf,
    }

    impl SessionFixture {
        fn new(session_ids: &[&str]) -> Self {
            let data_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/agent-session-tests")
                .join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(get_data_dir(&data_dir)).expect("create threads root");
            for session_id in session_ids {
                std::fs::create_dir_all(get_thread_dir(&data_dir, session_id))
                    .expect("create thread directory");
            }
            Self { data_dir }
        }
    }

    impl Drop for SessionFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data_dir);
        }
    }

    #[test]
    fn tool_arguments_are_prompt_visible_only_until_the_turn_finishes() {
        let mut state = AgentSessionState::new("thread-a");
        state.push_tool_observations(
            &[ToolCallPayload {
                tool: "os.fs.read".into(),
                args: serde_json::json!({"path": "secret.txt"}),
            }],
            &[ToolOutcome::ok("contents")],
        );

        assert!(state
            .render_conversation()
            .contains(r#"{"path":"secret.txt"}"#));
        assert!(!serde_json::to_string(&state)
            .expect("serialize session")
            .contains("secret.txt"));

        state.finish_turn();
        assert!(!state.render_conversation().contains("secret.txt"));
    }

    #[test]
    fn verbose_tool_results_are_compressed_without_mutating_the_source_outcome() {
        let mut state = AgentSessionState::new("thread-a");
        let detailed = (0..30)
            .map(|index| format!("detailed line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let outcome = ToolOutcome::ok(detailed.clone());
        state.push_tool_observations(
            &[ToolCallPayload {
                tool: "os.fs.read".into(),
                args: serde_json::json!({"path": "large.txt"}),
            }],
            std::slice::from_ref(&outcome),
        );

        let rendered = state.render_conversation();
        assert!(rendered.contains("… [omitted 18 lines]"));
        assert!(rendered.contains("detailed line 29"));
        assert!(!rendered.contains("detailed line 0\n"));
        assert_eq!(outcome.summary, detailed);
        let persisted = serde_json::to_string(&state).expect("serialize compressed session");
        assert!(persisted.contains("omitted 18 lines"));
        assert!(!persisted.contains("detailed line 0"));
    }

    #[test]
    fn failed_verbose_results_keep_the_key_error_signature() {
        let mut state = AgentSessionState::new("thread-a");
        let output = [
            "initial setup",
            "Error: database connection failed",
            "unrelated context",
        ]
        .join("\n");
        state.push_tool_observations(
            &[ToolCallPayload {
                tool: "os.shell.run".into(),
                args: serde_json::json!({"cmd": "test"}),
            }],
            &[ToolOutcome::error(output)],
        );

        assert!(state
            .render_conversation()
            .contains("key: Error: database connection failed"));
    }

    #[test]
    fn concise_mutation_results_are_left_unchanged() {
        let mut state = AgentSessionState::new("thread-a");
        let summary = "Wrote 0 bytes to empty.txt (replace)";
        state.push_tool_observations(
            &[ToolCallPayload {
                tool: "os.fs.write".into(),
                args: serde_json::json!({"path": "empty.txt", "content": ""}),
            }],
            &[ToolOutcome::ok(summary)],
        );

        assert!(state.render_conversation().contains(summary));
    }

    #[tokio::test]
    async fn round_trip_preserves_bounded_transcript_count_and_loaded_tools() {
        let fixture = SessionFixture::new(&["thread-a"]);
        let mut state = AgentSessionState::new("thread-a");
        state.push_user("first question");
        state.push_tool_observations(
            &[ToolCallPayload {
                tool: "os.fs.read".into(),
                args: serde_json::json!({"path": "a.txt"}),
            }],
            &[ToolOutcome::ok("first observation")],
        );
        state.push_reply("first answer");
        state.set_loaded_tools(vec!["os.fs.hash".into()]);
        state.finish_turn();

        save_session(&fixture.data_dir, &state)
            .await
            .expect("save session");
        let loaded = load_session(&fixture.data_dir, "thread-a")
            .await
            .expect("load session");

        assert_eq!(loaded, state);
        assert_eq!(loaded.turn_count, 1);
        assert!(loaded.render_conversation().contains("first observation"));
        assert_eq!(loaded.loaded_tools, ["os.fs.hash"]);
    }

    #[tokio::test]
    async fn sessions_are_isolated_and_missing_state_starts_empty() {
        let fixture = SessionFixture::new(&["thread-a", "thread-b"]);
        let mut first = AgentSessionState::new("thread-a");
        first.push_user("only in a");
        first.finish_turn();
        save_session(&fixture.data_dir, &first)
            .await
            .expect("save first session");

        let second = load_session(&fixture.data_dir, "thread-b")
            .await
            .expect("load second session");
        assert_eq!(second.turn_count, 0);
        assert!(second.turns.is_empty());
        assert!(!second.render_conversation().contains("only in a"));
    }

    #[tokio::test]
    async fn reload_continues_turn_count() {
        let fixture = SessionFixture::new(&["thread-a"]);
        let mut state = AgentSessionState::new("thread-a");
        state.finish_turn();
        save_session(&fixture.data_dir, &state)
            .await
            .expect("save first turn");

        let mut reloaded = load_session(&fixture.data_dir, "thread-a")
            .await
            .expect("reload first turn");
        reloaded.finish_turn();
        save_session(&fixture.data_dir, &reloaded)
            .await
            .expect("save second turn");

        assert_eq!(
            load_session(&fixture.data_dir, "thread-a")
                .await
                .expect("reload second turn")
                .turn_count,
            2
        );
    }

    #[tokio::test]
    async fn malformed_and_oversized_state_fail_closed() {
        let fixture = SessionFixture::new(&["thread-a"]);
        let path = get_thread_dir(&fixture.data_dir, "thread-a").join(SESSION_FILE_NAME);
        tokio::fs::write(&path, b"{invalid")
            .await
            .expect("write malformed state");
        assert!(load_session(&fixture.data_dir, "thread-a").await.is_err());

        tokio::fs::write(&path, vec![b'x'; MAX_SESSION_FILE_BYTES as usize + 1])
            .await
            .expect("write oversized state");
        assert!(load_session(&fixture.data_dir, "thread-a").await.is_err());
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        for invalid in ["", ".", "..", "../outside", "nested/thread", "/absolute"] {
            assert!(validate_session_id(invalid).is_err(), "{invalid}");
        }
        assert!(validate_session_id("safe-thread_123").is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_thread_symlink_that_escapes_threads_root() {
        use std::os::unix::fs::symlink;

        let fixture = SessionFixture::new(&[]);
        let outside = fixture.data_dir.join("outside");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        symlink(&outside, get_thread_dir(&fixture.data_dir, "thread-link"))
            .expect("create escaping symlink");

        assert!(load_session(&fixture.data_dir, "thread-link")
            .await
            .is_err());
    }
}
