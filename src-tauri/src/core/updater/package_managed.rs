//! Package-managed installs: a distro package (AUR, a pacman repo, Flatpak,
//! ...) owns updates, so the built-in updater must neither check nor offer
//! one. The self-updater would fight the package manager — it either fails on
//! a root-owned install path or silently replaces files the package manager
//! tracks.
//!
//! A packager opts in with either switch:
//! - an empty `atomic-chat-package-managed` marker file next to the app
//!   executable — next to the `.AppImage` file itself for an intact AppImage,
//!   next to `usr/bin/Atomic-Chat` for an extracted one. This is the switch
//!   to prefer: it also covers launches that bypass a wrapper script, such as
//!   the autostart entry, which runs the binary (or `$APPIMAGE`) directly;
//! - `ATOMIC_CHAT_PACKAGE_MANAGED=1` in the environment (e.g. from a
//!   `/usr/bin` launcher script), for packages that cannot place a file.

use std::path::Path;

pub const PACKAGE_MANAGED_ENV: &str = "ATOMIC_CHAT_PACKAGE_MANAGED";
pub const PACKAGE_MANAGED_MARKER: &str = "atomic-chat-package-managed";
/// Set by the AppImage runtime to the path of the mounted `.AppImage` file;
/// `current_exe()` only sees the payload inside the mount.
const APPIMAGE_ENV: &str = "APPIMAGE";

fn env_value_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn marker_next_to(exe: &Path) -> bool {
    exe.parent()
        .is_some_and(|dir| dir.join(PACKAGE_MANAGED_MARKER).is_file())
}

/// Whether a package manager, not the app, owns updates for this install.
pub fn is_package_managed() -> bool {
    env_value_enabled(std::env::var(PACKAGE_MANAGED_ENV).ok().as_deref())
        || std::env::current_exe().is_ok_and(|exe| marker_next_to(&exe))
        || std::env::var_os(APPIMAGE_ENV)
            .is_some_and(|appimage| marker_next_to(Path::new(&appimage)))
}

/// Lets the frontend hide the update UI and skip the startup check.
#[tauri::command]
pub fn is_package_managed_install() -> bool {
    is_package_managed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_switch_accepts_common_truthy_values() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(env_value_enabled(Some(value)), "{value:?}");
        }
        for value in [None, Some(""), Some("0"), Some("false"), Some("no")] {
            assert!(!env_value_enabled(value), "{value:?}");
        }
    }

    #[test]
    fn marker_file_is_looked_up_next_to_the_executable() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("Atomic-Chat");
        assert!(!marker_next_to(&exe));
        std::fs::write(dir.path().join(PACKAGE_MANAGED_MARKER), "").unwrap();
        assert!(marker_next_to(&exe));
    }

    #[test]
    fn marker_file_is_looked_up_next_to_the_appimage() {
        // The same lookup serves `$APPIMAGE`, whose parent is the directory
        // the packager installed the `.AppImage` file into.
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("Atomic.Chat_2.2.23_amd64.AppImage");
        assert!(!marker_next_to(&appimage));
        std::fs::write(dir.path().join(PACKAGE_MANAGED_MARKER), "").unwrap();
        assert!(marker_next_to(&appimage));
    }
}
