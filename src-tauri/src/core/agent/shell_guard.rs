#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellGuardVerdict {
    Allow,
    ApprovalRequired(String),
    Block(String),
}

pub fn evaluate_shell_command(command: &str) -> ShellGuardVerdict {
    let normalized = command.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return ShellGuardVerdict::Block("command is empty".into());
    }
    #[cfg(windows)]
    if let Some(verdict) = evaluate_windows_shell_command(&normalized) {
        return verdict;
    }
    if is_catastrophic_command(&normalized) {
        return ShellGuardVerdict::Block(
            "command matches a catastrophic system-destruction pattern".into(),
        );
    }
    if contains_approval_pattern(&normalized) {
        return ShellGuardVerdict::ApprovalRequired(
            "command may mutate, network, process, or system state".into(),
        );
    }
    ShellGuardVerdict::Allow
}

pub fn needs_shell_interpretation(cmd: &str, args: &[String]) -> bool {
    contains_shell_syntax(cmd)
        || args.iter().any(|arg| contains_shell_syntax(arg))
        || (args.is_empty() && cmd.split_whitespace().count() > 1)
}

pub fn join_command_stream(cmd: &str, args: &[String]) -> String {
    std::iter::once(cmd)
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
}

fn contains_shell_syntax(value: &str) -> bool {
    value
        .chars()
        .any(|character| matches!(character, '|' | '&' | ';' | '>' | '<' | '$' | '`'))
        || value.contains("$(")
        || value.contains("${")
}

fn is_catastrophic_command(command: &str) -> bool {
    if command.contains(":(){:|:&};:") || command.contains(":(){ :|:& };:") {
        return true;
    }
    shell_segments(command).any(is_catastrophic_segment)
}

fn is_catastrophic_segment(segment: &str) -> bool {
    let mut tokens = segment.split_whitespace().collect::<Vec<_>>();
    if tokens.first().is_some_and(|token| *token == "sudo") {
        tokens.remove(0);
        while tokens.first().is_some_and(|token| token.starts_with('-')) {
            let option = tokens.remove(0);
            if matches!(
                option,
                "-u" | "-g" | "-h" | "-p" | "-C" | "-T" | "-r" | "-t"
            ) && !tokens.is_empty()
            {
                tokens.remove(0);
            }
        }
    }
    while tokens
        .first()
        .is_some_and(|token| matches!(*token, "command" | "env"))
    {
        tokens.remove(0);
    }
    while tokens
        .first()
        .is_some_and(|token| token.contains('=') && !token.starts_with('='))
    {
        tokens.remove(0);
    }
    if tokens.is_empty() {
        return false;
    }
    let command = executable_name(tokens[0]);
    if matches!(command, "mkfs" | "fdisk" | "diskpart") {
        return true;
    }
    if command == "format" && tokens.get(1).is_some_and(|target| target.ends_with(':')) {
        return true;
    }
    if command == "dd"
        && tokens
            .iter()
            .any(|token| token.starts_with("of=/dev/") || token.starts_with("of=\\\\.\\"))
    {
        return true;
    }
    if command == "rm" {
        let recursive = tokens.iter().any(|token| {
            *token == "--recursive"
                || (token.starts_with('-') && !token.starts_with("--") && token.contains('r'))
        });
        let force = tokens.iter().any(|token| {
            *token == "--force"
                || (token.starts_with('-') && !token.starts_with("--") && token.contains('f'))
        });
        let catastrophic_target = tokens
            .iter()
            .map(|token| token.trim_matches(['\'', '"']))
            .any(|token| {
                matches!(
                    token,
                    "/" | "/*" | "//" | "~" | "~/*" | "$home" | "$home/*" | "${home}" | "${home}/*"
                )
            });
        return recursive && force && catastrophic_target;
    }
    false
}

fn contains_approval_pattern(command: &str) -> bool {
    shell_segments(command).any(|segment| {
        let first = executable_name(segment.split_whitespace().next().unwrap_or_default());
        matches!(
            first,
            "rm" | "rmdir"
                | "mv"
                | "cp"
                | "chmod"
                | "chown"
                | "kill"
                | "pkill"
                | "killall"
                | "curl"
                | "wget"
                | "ssh"
                | "scp"
                | "sudo"
                | "launchctl"
                | "systemctl"
                | "shutdown"
                | "reboot"
                | "powershell"
                | "pwsh"
        )
    }) || command.contains(" >")
        || command.contains(">>")
}

fn executable_name(value: &str) -> &str {
    let name = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .trim_matches(['\'', '"']);
    #[cfg(windows)]
    {
        return name
            .strip_suffix(".exe")
            .or_else(|| name.strip_suffix(".com"))
            .unwrap_or(name);
    }
    #[cfg(not(windows))]
    {
        name
    }
}

fn shell_segments(command: &str) -> impl Iterator<Item = &str> {
    command
        .split([';', '|', '&'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
}

#[cfg(windows)]
fn evaluate_windows_shell_command(command: &str) -> Option<ShellGuardVerdict> {
    let mut approval_required = false;
    for segment in shell_segments(command) {
        match evaluate_windows_segment(segment) {
            Some(ShellGuardVerdict::Block(reason)) => {
                return Some(ShellGuardVerdict::Block(reason));
            }
            Some(ShellGuardVerdict::ApprovalRequired(_)) => approval_required = true,
            Some(ShellGuardVerdict::Allow) | None => {}
        }
    }
    approval_required.then(|| {
        ShellGuardVerdict::ApprovalRequired(
            "command may mutate Windows filesystem, process, network, or system state".into(),
        )
    })
}

#[cfg(windows)]
fn evaluate_windows_segment(segment: &str) -> Option<ShellGuardVerdict> {
    let tokens = windows_tokens(segment);
    if tokens.first().is_some_and(|token| is_batch_script(token)) {
        return Some(ShellGuardVerdict::Block(
            "opaque Windows batch scripts cannot be inspected safely".into(),
        ));
    }
    let program = executable_name(tokens.first()?.as_str());
    if matches!(program, "powershell" | "pwsh") {
        if tokens
            .iter()
            .skip(1)
            .any(|token| is_encoded_command_switch(token))
        {
            return Some(ShellGuardVerdict::Block(
                "encoded PowerShell commands cannot be inspected safely".into(),
            ));
        }
        if let Some(index) = tokens
            .iter()
            .position(|token| is_powershell_command_switch(token))
        {
            let payload = tokens[index + 1..].join(" ");
            if is_catastrophic_powershell(&payload) {
                return Some(catastrophic_windows_block());
            }
        }
        return Some(windows_approval());
    }
    if program == "cmd" {
        if tokens
            .iter()
            .skip(1)
            .any(|token| is_attached_cmd_execute_switch(token))
        {
            return Some(ShellGuardVerdict::Block(
                "attached cmd execution switches cannot be inspected safely".into(),
            ));
        }
        let Some(index) = tokens.iter().position(|token| is_cmd_execute_switch(token)) else {
            return Some(windows_approval());
        };
        let payload_tokens = &tokens[index + 1..];
        if payload_tokens
            .first()
            .is_some_and(|token| is_batch_script(token))
        {
            return Some(ShellGuardVerdict::Block(
                "opaque Windows batch scripts cannot be inspected safely".into(),
            ));
        }
        let payload = payload_tokens.join(" ");
        if payload.is_empty() {
            return Some(ShellGuardVerdict::Block(
                "cmd execution switch requires an inspectable command".into(),
            ));
        }
        if is_catastrophic_command(&payload) || is_catastrophic_windows_command(&payload) {
            return Some(catastrophic_windows_block());
        }
        return evaluate_windows_shell_command(&payload).or(Some(ShellGuardVerdict::Allow));
    }
    if is_catastrophic_windows_tokens(&tokens) {
        return Some(catastrophic_windows_block());
    }
    if is_windows_mutator(program) {
        return Some(windows_approval());
    }
    None
}

#[cfg(windows)]
fn windows_approval() -> ShellGuardVerdict {
    ShellGuardVerdict::ApprovalRequired(
        "command may mutate Windows filesystem, process, network, or system state".into(),
    )
}

#[cfg(windows)]
fn catastrophic_windows_block() -> ShellGuardVerdict {
    ShellGuardVerdict::Block(
        "command matches a catastrophic Windows system-destruction pattern".into(),
    )
}

#[cfg(windows)]
fn is_catastrophic_windows_command(command: &str) -> bool {
    shell_segments(command).any(|segment| {
        let tokens = windows_tokens(segment);
        is_catastrophic_windows_tokens(&tokens)
    })
}

#[cfg(windows)]
fn is_catastrophic_windows_tokens(tokens: &[String]) -> bool {
    let Some(first) = tokens.first() else {
        return false;
    };
    let program = executable_name(first);
    if matches!(program, "diskpart" | "bootrec" | "bootsect" | "mbr2gpt") {
        return true;
    }
    if program == "format" && tokens.iter().skip(1).any(|token| is_drive_target(token)) {
        return true;
    }
    if program == "bcdedit"
        && tokens
            .iter()
            .skip(1)
            .any(|token| matches!(token.as_str(), "/delete" | "-delete" | "/deletevalue"))
    {
        return true;
    }
    if matches!(program, "del" | "erase")
        && has_switch(tokens, &["/s"])
        && has_switch(tokens, &["/q", "/f"])
        && tokens.iter().skip(1).any(|token| is_system_target(token))
    {
        return true;
    }
    if matches!(program, "rd" | "rmdir")
        && has_switch(tokens, &["/s"])
        && has_switch(tokens, &["/q"])
        && tokens.iter().skip(1).any(|token| is_system_target(token))
    {
        return true;
    }
    if program == "cipher"
        && tokens
            .iter()
            .skip(1)
            .any(|token| token.starts_with("/w:") && is_system_target(&token[3..]))
    {
        return true;
    }
    matches!(program, "clear-disk" | "initialize-disk")
}

#[cfg(windows)]
fn is_catastrophic_powershell(command: &str) -> bool {
    shell_segments(command).any(|segment| {
        let tokens = windows_tokens(segment);
        let Some(first) = tokens.first() else {
            return false;
        };
        let command = executable_name(first);
        if matches!(command, "clear-disk" | "initialize-disk") {
            return true;
        }
        matches!(
            command,
            "remove-item" | "ri" | "rm" | "del" | "erase" | "rd" | "rmdir"
        ) && has_switch(&tokens, &["-recurse", "-r"])
            && has_switch(&tokens, &["-force"])
            && tokens.iter().skip(1).any(|token| is_system_target(token))
    })
}

#[cfg(windows)]
fn is_windows_mutator(command: &str) -> bool {
    matches!(
        command,
        "del"
            | "erase"
            | "rd"
            | "rmdir"
            | "copy"
            | "xcopy"
            | "robocopy"
            | "move"
            | "ren"
            | "rename"
            | "mkdir"
            | "md"
            | "mklink"
            | "attrib"
            | "takeown"
            | "icacls"
            | "taskkill"
            | "sc"
            | "reg"
            | "net"
            | "netsh"
            | "shutdown"
            | "bcdedit"
            | "reagentc"
            | "dism"
            | "cipher"
    )
}

#[cfg(windows)]
fn is_cmd_execute_switch(token: &str) -> bool {
    matches!(token, "/c" | "/k")
}

#[cfg(windows)]
fn is_attached_cmd_execute_switch(token: &str) -> bool {
    token.len() > 2 && (token.starts_with("/c") || token.starts_with("/k"))
}

#[cfg(windows)]
fn is_powershell_command_switch(token: &str) -> bool {
    matches!(token, "-command" | "-c" | "/command")
        || token.starts_with("-command:")
        || token.starts_with("/command:")
}

#[cfg(windows)]
fn is_encoded_command_switch(token: &str) -> bool {
    matches!(token, "-encodedcommand" | "-enc" | "-e" | "/encodedcommand")
        || token.starts_with("-encodedcommand:")
        || token.starts_with("-enc:")
        || token.starts_with("/encodedcommand:")
}

#[cfg(windows)]
fn is_batch_script(token: &str) -> bool {
    let token = token.trim_matches(['\'', '"']).to_ascii_lowercase();
    token.ends_with(".cmd") || token.ends_with(".bat")
}

#[cfg(windows)]
fn has_switch(tokens: &[String], switches: &[&str]) -> bool {
    tokens
        .iter()
        .skip(1)
        .any(|token| switches.contains(&token.as_str()))
}

#[cfg(windows)]
fn is_drive_target(token: &str) -> bool {
    let token = normalized_windows_target(token);
    let bytes = token.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[cfg(windows)]
fn is_system_target(token: &str) -> bool {
    let target = normalized_windows_target(token);
    if matches!(
        target.as_str(),
        "%systemroot%"
            | "%windir%"
            | "%systemdrive%\\"
            | "%systemdrive%\\*"
            | "$env:systemroot"
            | "$env:windir"
            | "$env:systemdrive\\"
            | "$env:systemdrive\\*"
            | "\\"
            | "\\*"
    ) {
        return true;
    }
    let without_wildcards = target.trim_end_matches(['*', '.', ' ']);
    let bytes = without_wildcards.as_bytes();
    if bytes.len() == 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return true;
    }
    let path = without_wildcards
        .strip_prefix(r"\\?\")
        .unwrap_or(without_wildcards);
    let Some(rest) = path.get(2..) else {
        return false;
    };
    path.as_bytes().get(1) == Some(&b':')
        && (rest == r"\windows"
            || rest.starts_with(r"\windows\")
            || rest == r"\program files"
            || rest.starts_with(r"\program files\")
            || rest == r"\program files (x86)"
            || rest.starts_with(r"\program files (x86)\"))
}

#[cfg(windows)]
fn normalized_windows_target(token: &str) -> String {
    token
        .trim_matches(['\'', '"'])
        .replace('/', "\\")
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn windows_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in command.chars() {
        match (quote, character) {
            (Some(active), value) if value == active => quote = None,
            (None, '"' | '\'') => quote = Some(character),
            (None, value) if value.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_argv_does_not_require_shell() {
        assert!(!needs_shell_interpretation(
            "git",
            &["status".into(), "--short".into()]
        ));
    }

    #[test]
    fn routes_shell_syntax_and_prejoined_commands() {
        assert!(needs_shell_interpretation("printf hi | wc -c", &[]));
        assert!(needs_shell_interpretation("echo", &["$HOME".into()]));
        assert!(needs_shell_interpretation("git status --short", &[]));
    }

    #[test]
    fn hard_blocks_catastrophic_commands() {
        assert!(matches!(
            evaluate_shell_command("rm -rf /"),
            ShellGuardVerdict::Block(_)
        ));
        assert!(matches!(
            evaluate_shell_command("dd if=/dev/zero of=/dev/disk0"),
            ShellGuardVerdict::Block(_)
        ));
        assert!(matches!(
            evaluate_shell_command("echo ready && sudo rm -rf /"),
            ShellGuardVerdict::Block(_)
        ));
        assert!(matches!(
            evaluate_shell_command("env MODE=unsafe /bin/rm -r -f -- \"/\""),
            ShellGuardVerdict::Block(_)
        ));
    }

    #[test]
    fn flags_destructive_and_network_commands_for_approval() {
        assert!(matches!(
            evaluate_shell_command("rm -f ./cache"),
            ShellGuardVerdict::ApprovalRequired(_)
        ));
        assert!(matches!(
            evaluate_shell_command("curl https://example.com"),
            ShellGuardVerdict::ApprovalRequired(_)
        ));
    }

    #[test]
    fn allows_read_only_command_shape() {
        assert_eq!(
            evaluate_shell_command("git status --short"),
            ShellGuardVerdict::Allow
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_shell_guard_table() {
        let cases = [
            ("dir C:\\work", "allow"),
            ("where.exe git", "allow"),
            ("cmd.exe /C dir C:\\work", "allow"),
            ("cmd /k \"echo ready && dir\"", "allow"),
            ("copy.exe source.txt target.txt", "approval"),
            ("move source.txt target.txt", "approval"),
            ("del /q cache.tmp", "approval"),
            ("rmdir /s /q .\\cache", "approval"),
            ("taskkill.exe /PID 42 /F", "approval"),
            (
                "reg.exe add HKCU\\Software\\Atomic /v Enabled /d 1",
                "approval",
            ),
            ("cmd.exe /C \"copy source.txt target.txt\"", "approval"),
            ("cmd /C \"echo ready && del /q cache.tmp\"", "approval"),
            (
                "powershell.exe -NoProfile -Command Get-ChildItem C:\\work",
                "approval",
            ),
            (
                "pwsh -Command \"Set-Content -Path note.txt -Value ready\"",
                "approval",
            ),
            ("format.com C:", "block"),
            ("format.exe C: /Q", "block"),
            ("diskpart.exe /s wipe.txt", "block"),
            ("bootrec.exe /fixmbr", "block"),
            ("bootsect /nt60 sys", "block"),
            ("bcdedit.exe /delete {default}", "block"),
            ("del /s /q C:\\*", "block"),
            ("erase /s /f C:\\Windows\\*", "block"),
            ("rd /s /q %SystemRoot%", "block"),
            ("rmdir /s /q \"C:\\Program Files\"", "block"),
            ("cipher /w:C:\\", "block"),
            ("Clear-Disk -Number 0 -RemoveData -Confirm:$false", "block"),
            ("Initialize-Disk -Number 0", "block"),
            ("cmd.exe /C \"rd /s /q C:\\Windows\"", "block"),
            ("cmd /C \"echo ready && format.exe C: /Q\"", "block"),
            (
                "powershell.exe -Command \"Remove-Item C:\\ -Recurse -Force\"",
                "block",
            ),
            (
                "pwsh.exe -Command \"Remove-Item $env:SystemRoot -Recurse -Force\"",
                "block",
            ),
            (
                "powershell -EncodedCommand VwByAGkAdABlAC0ASABvAHMAdAA=",
                "block",
            ),
            ("pwsh.exe -enc VwByAGkAdABlAC0ASABvAHMAdAA=", "block"),
            (
                "powershell.exe -EncodedCommand:VwByAGkAdABlAC0ASABvAHMAdAA=",
                "block",
            ),
            ("cmd.exe /cdel /s /q C:\\*", "block"),
            ("C:\\skills\\cleanup.cmd --all", "block"),
            ("cmd.exe /C C:\\skills\\cleanup.cmd", "block"),
            ("cmd /K \"C:\\skills\\inspect.bat\" --verbose", "block"),
            ("rd /s /q %SystemDrive%\\", "block"),
        ];

        for (command, expected) in cases {
            let verdict = evaluate_shell_command(command);
            assert!(
                matches!(
                    (expected, &verdict),
                    ("allow", ShellGuardVerdict::Allow)
                        | ("approval", ShellGuardVerdict::ApprovalRequired(_))
                        | ("block", ShellGuardVerdict::Block(_))
                ),
                "{command:?}: expected {expected}, got {verdict:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_root_detection_does_not_block_nearby_user_paths() {
        for command in [
            "del /s /q C:\\workspace\\*",
            "rmdir /s /q C:\\windows-backup",
            "powershell -Command \"Remove-Item C:\\work -Recurse -Force\"",
            "bcdedit /enum",
        ] {
            assert!(
                matches!(
                    evaluate_shell_command(command),
                    ShellGuardVerdict::ApprovalRequired(_)
                ),
                "{command:?} should require approval without being hard-blocked"
            );
        }
    }
}
