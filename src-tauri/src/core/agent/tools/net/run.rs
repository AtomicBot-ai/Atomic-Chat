//! Running the platform commands behind the `net.*` tools.
//!
//! Every command runs with a timeout, honours the turn's cancellation, never
//! opens a console window, and forces the C locale on Unix so the parsers see
//! English output. Values from the model never reach a shell unquoted: Windows
//! scripts take them through [`ps_quote`], Unix commands as separate argv
//! entries.

use std::time::Duration;

use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::core::process_env::sanitize_tokio_command;

/// One command to run, with the program resolved and arguments split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    pub fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        }
    }

    /// A Windows PowerShell script, run without the user's profile.
    pub fn powershell(script: &str) -> Self {
        Self::new(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
        )
    }
}

/// What a finished command produced.
#[derive(Debug, Clone, Default)]
pub struct CommandOutput {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    /// stdout and stderr together, for showing the raw result to the model.
    pub fn combined(&self) -> String {
        match (self.stdout.trim(), self.stderr.trim()) {
            ("", "") => String::new(),
            (out, "") => out.to_owned(),
            ("", err) => err.to_owned(),
            (out, err) => format!("{out}\n{err}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    Cancelled,
    TimedOut(Duration),
    /// The program is not installed / not on PATH.
    NotFound(String),
    Spawn(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("cancelled"),
            Self::TimedOut(limit) => write!(f, "timed out after {}s", limit.as_secs()),
            Self::NotFound(program) => write!(f, "`{program}` is not installed on this computer"),
            Self::Spawn(error) => write!(f, "could not start the command: {error}"),
        }
    }
}

pub async fn run(
    spec: &CommandSpec,
    timeout: Duration,
    cancellation: &CancellationToken,
) -> Result<CommandOutput, RunError> {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    sanitize_tokio_command(&mut command);
    command.kill_on_drop(true);
    #[cfg(unix)]
    {
        command.env("LC_ALL", "C").env("LANG", "C");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::select! {
        _ = cancellation.cancelled() => return Err(RunError::Cancelled),
        result = tokio::time::timeout(timeout, command.output()) => match result {
            Err(_) => return Err(RunError::TimedOut(timeout)),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(RunError::NotFound(spec.program.clone()))
            }
            Ok(Err(error)) => return Err(RunError::Spawn(error.to_string())),
            Ok(Ok(output)) => output,
        },
    };
    Ok(CommandOutput {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Quote a value as a PowerShell single-quoted literal. Inside single quotes
/// nothing is interpolated (`$`, backticks, subexpressions); the only escape
/// is a doubled quote.
pub fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A PowerShell array literal of quoted strings: `@('a','b')`.
pub fn ps_array(values: &[String]) -> String {
    format!(
        "@({})",
        values
            .iter()
            .map(|value| ps_quote(value))
            .collect::<Vec<_>>()
            .join(",")
    )
}

/// Quote a value for an AppleScript string literal inside `do shell script`.
pub fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Quote a value for a POSIX shell (single quotes; `'` becomes `'\''`).
pub fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Text that means the command needed administrator rights.
pub fn needs_admin(output: &CommandOutput) -> bool {
    let text = output.combined().to_lowercase();
    [
        "access is denied",
        "requires elevation",
        "permissiondenied",
        "permission denied",
        "operation not permitted",
        "not authorized",
        "must be run as administrator",
        "administrator privileges",
        "0x80070005",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

/// Wrap a Windows PowerShell script so it runs elevated through the UAC
/// prompt and its output comes back. The elevated process cannot inherit our
/// pipes, so it writes to a temp file the outer script reads back.
pub fn windows_elevated(script: &str, output_file: &str) -> CommandSpec {
    // A failing cmdlet leaves $LASTEXITCODE untouched, so errors are made
    // terminating and mapped to exit 1; native commands keep their own code.
    let inner = format!(
        "$ErrorActionPreference='Stop'; \
         try {{ & {{ {script} }} *> {out}; if ($LASTEXITCODE) {{ exit $LASTEXITCODE }}; exit 0 }} \
         catch {{ ($_ | Out-String) | Out-File -Append -FilePath {out}; exit 1 }}",
        out = ps_quote(output_file),
    );
    let encoded = encode_powershell(&inner);
    let outer = format!(
        "$ErrorActionPreference='Stop'; \
         try {{ $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
         -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',{encoded}) }} \
         catch {{ Write-Output 'RADIUM_ELEVATION_DECLINED'; exit 1223 }}; \
         if (Test-Path {out}) {{ Get-Content -Raw {out}; Remove-Item -Force {out} }}; exit $p.ExitCode",
        encoded = ps_quote(&encoded),
        out = ps_quote(output_file),
    );
    CommandSpec::powershell(&outer)
}

/// macOS: run a shell command through the native administrator prompt.
pub fn macos_elevated(shell_command: &str) -> CommandSpec {
    CommandSpec::new(
        "osascript",
        &[
            "-e",
            &format!(
                "do shell script {} with administrator privileges",
                applescript_quote(shell_command)
            ),
        ],
    )
}

/// Linux: run through polkit's graphical prompt.
pub fn linux_elevated(spec: &CommandSpec) -> CommandSpec {
    let mut args = vec![spec.program.clone()];
    args.extend(spec.args.iter().cloned());
    CommandSpec {
        program: "pkexec".into(),
        args,
    }
}

/// True when the user dismissed the elevation prompt.
pub fn elevation_declined(output: &CommandOutput) -> bool {
    output.stdout.contains("RADIUM_ELEVATION_DECLINED")
        || output.exit_code == Some(1223)
        || output.combined().to_lowercase().contains("user canceled")
        || output.combined().to_lowercase().contains("user cancelled")
        // pkexec: 126 = dismissed, 127 = not authorized.
        || matches!(output.exit_code, Some(126))
}

/// `-EncodedCommand` takes base64 of the UTF-16LE script.
fn encode_powershell(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64_encode(&bytes)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_quoting_neutralises_injection() {
        assert_eq!(ps_quote("Wi-Fi"), "'Wi-Fi'");
        assert_eq!(
            ps_quote("a'; Remove-Item C:\\ -Recurse; '"),
            "'a''; Remove-Item C:\\ -Recurse; '''"
        );
        assert_eq!(ps_quote("$(evil)`n"), "'$(evil)`n'");
        assert_eq!(
            ps_array(&["1.1.1.1".into(), "8.8.8.8".into()]),
            "@('1.1.1.1','8.8.8.8')"
        );
    }

    #[test]
    fn shell_and_applescript_quoting_escape_their_delimiters() {
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(
            applescript_quote("say \"hi\" \\ bye"),
            "\"say \\\"hi\\\" \\\\ bye\""
        );
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // PowerShell's own encoding of "dir": UTF-16LE then base64.
        assert_eq!(encode_powershell("dir"), "ZABpAHIA");
    }

    #[test]
    fn recognises_permission_failures_and_declined_prompts() {
        let denied = CommandOutput {
            success: false,
            exit_code: Some(1),
            stdout: String::new(),
            stderr: "Set-DnsClientServerAddress : Access is denied.".into(),
        };
        assert!(needs_admin(&denied));
        let fine = CommandOutput {
            success: true,
            exit_code: Some(0),
            stdout: "Windows IP Configuration".into(),
            stderr: String::new(),
        };
        assert!(!needs_admin(&fine));
        let declined = CommandOutput {
            success: false,
            exit_code: Some(1223),
            stdout: "RADIUM_ELEVATION_DECLINED".into(),
            stderr: String::new(),
        };
        assert!(elevation_declined(&declined));
    }

    #[test]
    fn elevated_windows_script_carries_the_script_only_encoded() {
        let spec = windows_elevated("Clear-DnsClientCache", "C:\\Temp\\out.txt");
        assert_eq!(spec.program, "powershell.exe");
        let script = spec.args.last().unwrap();
        assert!(script.contains("-Verb RunAs"));
        assert!(script.contains("'C:\\Temp\\out.txt'"));
        assert!(!script.contains("Clear-DnsClientCache"));
    }

    #[test]
    fn linux_elevation_prefixes_pkexec_and_keeps_argv() {
        let spec = linux_elevated(&CommandSpec::new("resolvectl", &["flush-caches"]));
        assert_eq!(spec.program, "pkexec");
        assert_eq!(spec.args, ["resolvectl", "flush-caches"]);
    }
}
