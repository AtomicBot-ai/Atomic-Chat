//! Environment cleanup for host executables spawned by the packaged app.
//!
//! AppRun injects library and plugin paths so Atomic Chat can load files from
//! its AppImage. Those paths are correct for the app and inference sidecars
//! deliberately launched inside its runtime, but not for host executables such
//! as `curl`, terminal emulators, or MCP servers: they can otherwise combine
//! Fedora's binaries with Ubuntu's bundled OpenSSL. Call these helpers only at
//! boundaries that intentionally launch a host executable.

#[cfg(any(target_os = "linux", test))]
pub(crate) const APPIMAGE_RUNTIME_ENV_VARS: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GIO_EXTRA_MODULES",
    "GIO_MODULE_DIR",
    "GSETTINGS_SCHEMA_DIR",
    "GST_PLUGIN_SCANNER",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GTK_PATH",
    "PERLLIB",
    "PYTHONHOME",
    "PYTHONPATH",
    "QT_PLUGIN_PATH",
];

#[cfg(target_os = "linux")]
fn appimage_runtime_active() -> bool {
    std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some()
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn strip_appimage_std_command(command: &mut std::process::Command) {
    for variable in APPIMAGE_RUNTIME_ENV_VARS {
        command.env_remove(variable);
    }
}

pub(crate) fn sanitize_std_command(command: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    if appimage_runtime_active() {
        strip_appimage_std_command(command);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

#[cfg(any(target_os = "linux", test))]
fn strip_appimage_tokio_command(command: &mut tokio::process::Command) {
    for variable in APPIMAGE_RUNTIME_ENV_VARS {
        command.env_remove(variable);
    }
}

pub(crate) fn sanitize_tokio_command(command: &mut tokio::process::Command) {
    #[cfg(target_os = "linux")]
    if appimage_runtime_active() {
        strip_appimage_tokio_command(command);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

#[cfg(any(target_os = "linux", test))]
fn strip_appimage_pty_command(command: &mut portable_pty::CommandBuilder) {
    for variable in APPIMAGE_RUNTIME_ENV_VARS {
        command.env_remove(variable);
    }
}

pub(crate) fn sanitize_pty_command(command: &mut portable_pty::CommandBuilder) {
    #[cfg(target_os = "linux")]
    if appimage_runtime_active() {
        strip_appimage_pty_command(command);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn removed_std_keys(command: &std::process::Command) -> Vec<std::ffi::OsString> {
        command
            .get_envs()
            .filter_map(|(key, value)| value.is_none().then(|| key.to_os_string()))
            .collect()
    }

    fn assert_runtime_keys_removed(command: &std::process::Command) {
        let removed = removed_std_keys(command);
        for variable in APPIMAGE_RUNTIME_ENV_VARS {
            assert!(
                removed.iter().any(|key| key == variable),
                "{variable} must be removed"
            );
        }
        for variable in ["HOME", "PATH", "XDG_DATA_DIRS"] {
            assert!(
                !removed.iter().any(|key| key == variable),
                "{variable} must be preserved"
            );
        }
    }

    #[test]
    fn sanitizes_std_commands() {
        let mut command = std::process::Command::new("curl");
        strip_appimage_std_command(&mut command);
        assert_runtime_keys_removed(&command);
    }

    #[test]
    fn sanitizes_tokio_commands() {
        let mut command = tokio::process::Command::new("curl");
        strip_appimage_tokio_command(&mut command);
        assert_runtime_keys_removed(command.as_std());
    }

    #[test]
    fn sanitizes_pty_commands() {
        let mut command = portable_pty::CommandBuilder::new("curl");
        for variable in APPIMAGE_RUNTIME_ENV_VARS {
            command.env(variable, "/tmp/appimage");
        }
        command.env("PATH", "/usr/bin");
        strip_appimage_pty_command(&mut command);
        for variable in APPIMAGE_RUNTIME_ENV_VARS {
            assert!(
                command.get_env(variable).is_none(),
                "{variable} must be removed"
            );
        }
        assert_eq!(
            command.get_env("PATH"),
            Some(std::ffi::OsStr::new("/usr/bin"))
        );
    }
}
