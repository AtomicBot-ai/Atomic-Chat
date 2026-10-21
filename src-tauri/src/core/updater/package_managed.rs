//! Package-managed installs: a distro package (AUR, a pacman repo, Flatpak,
//! ...) owns updates, so the built-in updater must neither check nor offer
//! one. The self-updater would fight the package manager — it either fails on
//! a root-owned install path or silently replaces files the package manager
//! tracks.
//!
//! A packager opts in with either switch:
//! - `ATOMIC_CHAT_PACKAGE_MANAGED=1` in the environment (e.g. from the
//!   `/usr/bin` launcher script), or
//! - an empty `atomic-chat-package-managed` marker file next to the app
//!   executable, for installs whose desktop entry runs the binary directly.

use std::path::Path;

pub const PACKAGE_MANAGED_ENV: &str = "ATOMIC_CHAT_PACKAGE_MANAGED";
pub const PACKAGE_MANAGED_MARKER: &str = "atomic-chat-package-managed";

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
}
