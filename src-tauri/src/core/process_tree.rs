use std::path::Path;
use tokio::process::{Child, Command};

#[cfg(unix)]
pub(crate) fn configure_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    unsafe {
        command.as_std_mut().pre_exec(|| {
            nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))
                .map_err(|error| std::io::Error::from_raw_os_error(error as i32))
        });
    }
}

#[cfg(windows)]
pub(crate) fn configure_process_tree(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command
        .as_std_mut()
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn configure_process_tree(_command: &mut Command) {}

pub(crate) async fn terminate_process_tree(child: &mut Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid.and_then(|value| i32::try_from(value).ok()) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGKILL,
        );
    }

    #[cfg(windows)]
    if let Some(pid) = pid {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        use std::os::windows::process::CommandExt;
        taskkill.as_std_mut().creation_flags(0x0800_0000);
        let _ = taskkill.status().await;
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub(crate) fn interpreter_invocation(
    script_path: &Path,
    user_args: Vec<String>,
    bundled_script_runtime: Option<&Path>,
) -> Result<(String, Vec<String>), String> {
    let extension = script_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let path = script_path.display().to_string();
    let invocation = match extension.as_str() {
        "sh" => ("bash".into(), prepend(path, user_args)),
        "ps1" => (
            if cfg!(windows) {
                "powershell.exe".into()
            } else {
                "pwsh".into()
            },
            // Windows clients default to the `Restricted` execution policy,
            // under which `-File` refuses every script; scope the bypass to
            // this one process.
            if cfg!(windows) {
                vec![
                    "-NoProfile".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                ]
            } else {
                vec!["-NoProfile".into()]
            }
            .into_iter()
            .chain(["-File".into(), path])
            .chain(user_args)
            .collect(),
        ),
        "js" | "mjs" | "cjs" | "ts" => (
            bundled_script_runtime
                .filter(|runtime| runtime.is_file())
                .map_or_else(|| "bun".into(), |runtime| runtime.display().to_string()),
            prepend(path, user_args),
        ),
        "cmd" | "bat" if cfg!(windows) => (
            "cmd.exe".into(),
            ["/C".into(), path].into_iter().chain(user_args).collect(),
        ),
        "cmd" | "bat" => return Err("Windows batch scripts cannot run on this platform".into()),
        _ => (path, user_args),
    };
    Ok(invocation)
}

fn prepend(first: String, rest: Vec<String>) -> Vec<String> {
    std::iter::once(first).chain(rest).collect()
}
