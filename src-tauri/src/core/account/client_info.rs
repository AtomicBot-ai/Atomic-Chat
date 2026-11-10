//! The `client` object every sign-in carries. The backend shows it in the
//! account's device list and in the sign-in email, so it describes this
//! machine in words its owner recognises. It goes to our account API only.

use serde::Serialize;

pub const CLIENT_TYPE: &str = "desktop";

const MAX_DEVICE_NAME_CHARS: usize = 100;
const MAX_APP_VERSION_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ClientInfo {
    pub client_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installation_id: Option<String>,
}

impl ClientInfo {
    pub fn new(device_name: Option<String>, app_version: &str, installation_id: &str) -> Self {
        Self {
            client_type: CLIENT_TYPE,
            device_name,
            platform: platform().map(str::to_string),
            app_version: sanitize_app_version(app_version),
            installation_id: Some(installation_id.to_string()),
        }
    }
}

/// `^[a-z0-9_-]{1,32}$` on the backend; only the desktop targets are named.
pub fn platform() -> Option<&'static str> {
    match std::env::consts::OS {
        "macos" => Some("macos"),
        "windows" => Some("windows"),
        "linux" => Some("linux"),
        _ => None,
    }
}

/// The backend takes `^[A-Za-z0-9._+-]+$`, at most 32 characters; anything
/// else is dropped rather than sent and refused.
pub fn sanitize_app_version(raw: &str) -> Option<String> {
    let version = raw.trim();
    let valid = !version.is_empty()
        && version.len() <= MAX_APP_VERSION_LEN
        && version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'));
    valid.then(|| version.to_string())
}

/// Trim, drop control characters and the mDNS `.local` suffix, cap at 100
/// characters. Empty means "no name".
pub fn sanitize_device_name(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|c| !c.is_control()).collect();
    let mut name = cleaned.trim();
    if let Some(stripped) = name.strip_suffix(".local") {
        name = stripped.trim_end();
    }
    if name.is_empty() {
        return None;
    }
    Some(name.chars().take(MAX_DEVICE_NAME_CHARS).collect())
}

/// The name people gave this computer: the macOS Computer Name ("Ann's
/// MacBook Pro"), else the host name. Spawns a process on macOS, so callers
/// compute it once.
pub fn device_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let computer_name = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|name| sanitize_device_name(&name));
        if computer_name.is_some() {
            return computer_name;
        }
    }

    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .and_then(|name| sanitize_device_name(&name))
}
