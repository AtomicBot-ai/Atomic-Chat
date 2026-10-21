use serde::{Deserialize, Serialize};

/// What the model asked for: a shell command line (`run_command`) or a
/// script in one of the languages this machine can run (`run_script`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecKind {
    Command,
    Script,
}

/// Languages `run_script` accepts. Only the ones whose runtime is present
/// reach the model (`ChatExecStatus::languages`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptLanguage {
    Python,
    Javascript,
    Typescript,
    Shell,
    Powershell,
    Ruby,
    Perl,
    Php,
    Lua,
    R,
}

impl ScriptLanguage {
    pub const ALL: [ScriptLanguage; 10] = [
        ScriptLanguage::Python,
        ScriptLanguage::Javascript,
        ScriptLanguage::Typescript,
        ScriptLanguage::Shell,
        ScriptLanguage::Powershell,
        ScriptLanguage::Ruby,
        ScriptLanguage::Perl,
        ScriptLanguage::Php,
        ScriptLanguage::Lua,
        ScriptLanguage::R,
    ];
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatExecRequest {
    /// The model's tool call id; `chat_exec_cancel` takes the same value.
    pub call_id: String,
    pub thread_id: String,
    pub kind: ExecKind,
    #[serde(default)]
    pub language: Option<ScriptLanguage>,
    /// The command line, or the script's source.
    pub source: String,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SandboxKind {
    /// Windows: inside a Microsoft MXC process container.
    Mxc,
    /// On the host, as the user.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatus {
    pub kind: SandboxKind,
    /// Why there is no sandbox where one was expected (Windows only).
    pub reason: Option<String>,
}

/// One of the user's own folders, as the model is told to reach it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFolder {
    /// `desktop`, `documents` or `downloads`.
    pub kind: &'static str,
    /// `~/…` under the home folder on macOS/Linux, absolute on Windows.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatExecStatus {
    pub supported: bool,
    /// `macos`, `windows` or `linux`.
    pub os: &'static str,
    /// The shell `run_command` goes through: `sh` or `cmd`.
    pub shell: &'static str,
    pub languages: Vec<ScriptLanguage>,
    pub sandbox: SandboxStatus,
    /// The user's Desktop, Documents and Downloads, where they exist.
    pub user_folders: Vec<UserFolder>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatExecResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// Some output was left out (the middle of a long stream).
    pub truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
    pub sandbox: SandboxKind,
    /// The folder the command ran in: the chat's own, or a secure project's
    /// first editable folder.
    pub workdir: String,
    pub duration_ms: u64,
    /// What the model should know about a failure the OS caused (a macOS
    /// privacy prompt, the Windows sandbox's reach).
    pub hint: Option<String>,
}
