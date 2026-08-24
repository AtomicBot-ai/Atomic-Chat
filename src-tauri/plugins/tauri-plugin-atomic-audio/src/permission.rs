//! Microphone permission, per OS.
//!
//! This has to be a native query, not a probe. On macOS a denied microphone
//! makes CoreAudio deliver *silence* rather than an error, so "recording
//! produced nothing" cannot distinguish a refused permission from a quiet room.
//! The only honest answer comes from `AVCaptureDevice`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MicPermission {
    Granted,
    Denied,
    /// Never asked. The OS will prompt on first capture.
    Undetermined,
    /// No permission model on this platform, or the API is unavailable.
    Unsupported,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::MicPermission;
    use block2::RcBlock;
    use objc2::runtime::{AnyClass, Bool};
    use objc2::msg_send;
    use objc2_foundation::NSString;
    use std::sync::mpsc;
    use std::time::Duration;

    // `AVCaptureDevice` lives in AVFoundation; without this the class is not
    // registered and the lookup below returns None.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// `AVMediaTypeAudio` is the four-char code "soun".
    const MEDIA_TYPE_AUDIO: &str = "soun";

    /// The user has up to this long to answer the OS prompt.
    const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

    fn class() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    fn from_raw(raw: isize) -> MicPermission {
        // AVAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied,
        // 3 authorized. "Restricted" (parental controls / MDM) is a denial the
        // user cannot lift from our UI, but the recovery copy is the same.
        match raw {
            0 => MicPermission::Undetermined,
            1 | 2 => MicPermission::Denied,
            3 => MicPermission::Granted,
            _ => MicPermission::Unsupported,
        }
    }

    pub fn status() -> MicPermission {
        let Some(cls) = class() else {
            return MicPermission::Unsupported;
        };
        let media = NSString::from_str(MEDIA_TYPE_AUDIO);
        let raw: isize =
            unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
        from_raw(raw)
    }

    pub fn request() -> MicPermission {
        let current = status();
        if current != MicPermission::Undetermined {
            return current;
        }
        let Some(cls) = class() else {
            return MicPermission::Unsupported;
        };

        let (tx, rx) = mpsc::channel::<bool>();
        // The handler fires on an arbitrary dispatch queue. Sending on a
        // disconnected channel is an Err we deliberately ignore: it only means
        // we timed out and stopped listening.
        let block = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });

        let media = NSString::from_str(MEDIA_TYPE_AUDIO);
        unsafe {
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: &*media,
                completionHandler: &*block,
            ];
        }

        match rx.recv_timeout(PROMPT_TIMEOUT) {
            Ok(true) => MicPermission::Granted,
            Ok(false) => MicPermission::Denied,
            // Timed out waiting on the user. Re-read rather than guessing.
            Err(_) => status(),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::MicPermission;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const CONSENT_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    pub fn status() -> MicPermission {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(key) = hkcu.open_subkey(CONSENT_PATH) else {
            // No entry means the user has never been asked for this machine.
            return MicPermission::Undetermined;
        };
        match key.get_value::<String, _>("Value") {
            Ok(value) if value.eq_ignore_ascii_case("Allow") => MicPermission::Granted,
            Ok(value) if value.eq_ignore_ascii_case("Deny") => MicPermission::Denied,
            _ => MicPermission::Undetermined,
        }
    }

    pub fn request() -> MicPermission {
        // Windows has no request API for desktop apps: the consent prompt is
        // raised by the capture attempt itself. Report what we know and let
        // `start_dictation` map a failed stream build onto PermissionDenied.
        status()
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::MicPermission;

    pub fn status() -> MicPermission {
        // Linux desktops have no per-app microphone gate we can query, and the
        // AppImage is not sandboxed. Treat capture as allowed and let a failed
        // stream build report the real problem.
        MicPermission::Granted
    }

    pub fn request() -> MicPermission {
        MicPermission::Granted
    }
}

/// Current permission, without prompting.
pub fn status() -> MicPermission {
    imp::status()
}

/// Prompt if the OS supports it, then report the outcome.
pub fn request() -> MicPermission {
    imp::request()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_is_a_known_variant() {
        // Whatever this machine reports, it must be one of the four states and
        // must not panic — the whole app aborts on panic in release.
        let value = status();
        assert!(matches!(
            value,
            MicPermission::Granted
                | MicPermission::Denied
                | MicPermission::Undetermined
                | MicPermission::Unsupported
        ));
    }

    #[test]
    fn permission_serialises_lowercase_for_the_frontend() {
        let json = serde_json::to_string(&MicPermission::Undetermined).unwrap();
        assert_eq!(json, "\"undetermined\"");
    }
}
