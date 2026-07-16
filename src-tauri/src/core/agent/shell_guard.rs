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
    value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .trim_matches(['\'', '"'])
}

fn shell_segments(command: &str) -> impl Iterator<Item = &str> {
    command
        .split([';', '|', '&'])
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
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
}
