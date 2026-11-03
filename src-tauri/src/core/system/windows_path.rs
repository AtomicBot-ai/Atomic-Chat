//! Reading and editing the Windows `Path` without damaging it.
//!
//! The user `Path` lives in `HKCU\Environment` as a `REG_EXPAND_SZ` value. The
//! earlier code round-tripped it through PowerShell's stdout, which is encoded
//! in the console OEM code page: every entry with a character outside that page
//! (`C:\Users\Миша\…` on a non-Russian locale, any CJK path) came back as `?`
//! and was written back that way for good. `[Environment]::GetEnvironmentVariable`
//! also expands `%VAR%` references, and `SetEnvironmentVariable` stores a plain
//! `REG_SZ`, so `%USERPROFILE%\…` entries were frozen to one user's paths.
//!
//! Here the raw value is read and written through the registry with its own
//! type, and only the string editing in between is ours — pure functions,
//! tested on every platform.

// The editing helpers only have callers on Windows; the tests run everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

/// Strip the Windows extended-length / verbatim prefix (`\\?\` or `\\?\UNC\`)
/// from a path string.
///
/// Tauri's `resource_dir()` returns verbatim-prefixed paths on Windows
/// (e.g. `\\?\C:\Users\...\resources\bin`). That prefix is valid Win32 but does
/// not belong in the user PATH: some tools fail to resolve executables from a
/// `\\?\`-prefixed PATH entry because the prefix disables normal path parsing.
/// We always write the plain, normalized form instead.
pub(crate) fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // \\?\UNC\server\share -> \\server\share
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        // \\?\C:\... -> C:\...
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Expand `%NAME%` references the way Windows expands a `REG_EXPAND_SZ`
/// value: a name `lookup` knows is replaced, anything else (an undefined name,
/// a lone `%`) is kept verbatim.
pub(crate) fn expand_percent_vars(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match lookup(&after[..end]) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &after[end + 1..];
                }
                None => {
                    // Keep the first `%` and rescan from the second: it may
                    // open a reference of its own (`50%%TEMP%`).
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The form two PATH entries are compared in: expanded, without a verbatim
/// prefix or trailing separators, and case-folded (Windows paths are
/// case-insensitive beyond ASCII too).
fn comparable(entry: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let expanded = expand_percent_vars(entry.trim(), lookup);
    strip_verbatim_prefix(&expanded)
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

/// The non-empty entries of a PATH value, exactly as written.
fn entries(value: &str) -> Vec<&str> {
    value.split(';').filter(|e| !e.trim().is_empty()).collect()
}

/// `current` with `dir` as its first entry: every other copy of `dir` (the
/// verbatim, `%VAR%` or differently-cased spelling of it) and every `stale`
/// directory dropped, the rest kept byte for byte and in order. `None` when
/// that is what `current` already says, so nothing needs writing.
pub(crate) fn path_with_dir_first(
    current: &str,
    dir: &str,
    stale: &[&str],
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    let before = entries(current);
    let ours = strip_verbatim_prefix(dir);
    let mut drop: Vec<String> = stale.iter().map(|s| comparable(s, lookup)).collect();
    drop.push(comparable(&ours, lookup));
    let mut after: Vec<&str> = vec![ours.as_str()];
    after.extend(
        before
            .iter()
            .copied()
            .filter(|entry| !drop.contains(&comparable(entry, lookup))),
    );
    (after != before).then(|| after.join(";"))
}

/// `current` without any spelling of `dir`. `None` when it had none.
pub(crate) fn path_without_dir(
    current: &str,
    dir: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    let before = entries(current);
    let key = comparable(dir, lookup);
    let after: Vec<&str> = before
        .iter()
        .copied()
        .filter(|entry| comparable(entry, lookup) != key)
        .collect();
    (after.len() != before.len()).then(|| after.join(";"))
}

/// Join PATH lists in order, keeping the first spelling of each directory.
/// `None` when they hold no entry at all.
pub(crate) fn merge_path_lists(lists: &[&str]) -> Option<String> {
    let mut merged: Vec<&str> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for list in lists {
        for part in list.split(';').map(str::trim).filter(|p| !p.is_empty()) {
            if seen.insert(part.to_lowercase()) {
                merged.push(part);
            }
        }
    }
    (!merged.is_empty()).then(|| merged.join(";"))
}

/// A `REG_SZ` / `REG_EXPAND_SZ` payload (UTF-16LE, usually NUL-terminated) as
/// text. Anything after the first NUL is not part of the string.
pub(crate) fn decode_reg_string(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|unit| *unit != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

/// Text as a NUL-terminated UTF-16LE registry string payload.
pub(crate) fn encode_reg_string(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(std::iter::once(0))
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(windows)]
mod registry {
    use super::{decode_reg_string, encode_reg_string, expand_percent_vars};
    use winreg::enums::{
        RegType, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, REG_SZ,
    };
    use winreg::{RegKey, RegValue};

    const USER_ENVIRONMENT: &str = "Environment";
    const MACHINE_ENVIRONMENT: &str =
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

    /// A string value of an environment key, unexpanded, with its type.
    /// `Ok(None)` when the value is absent or not a string.
    fn read_raw(machine: bool, name: &str) -> std::io::Result<Option<(String, RegType)>> {
        let (root, path) = if machine {
            (HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT)
        } else {
            (HKEY_CURRENT_USER, USER_ENVIRONMENT)
        };
        let key = RegKey::predef(root).open_subkey_with_flags(path, KEY_READ)?;
        match key.get_raw_value(name) {
            Ok(value) if matches!(value.vtype, REG_SZ | REG_EXPAND_SZ) => {
                Ok(Some((decode_reg_string(&value.bytes), value.vtype)))
            }
            Ok(_) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Resolve `%NAME%` against this process, then the user's persisted
    /// variables (one set after the app started is only in the registry).
    fn lookup(name: &str) -> Option<String> {
        std::env::var(name)
            .ok()
            .or_else(|| read_raw(false, name).ok().flatten().map(|(text, _)| text))
    }

    /// The `lookup` PATH editing compares entries with.
    pub(crate) fn env_lookup(name: &str) -> Option<String> {
        lookup(name)
    }

    /// A User-scope variable as Windows would hand it to a new process
    /// (`REG_EXPAND_SZ` expanded), trimmed. `None` when absent or empty.
    pub(crate) fn read_user_env(name: &str) -> Option<String> {
        let (text, vtype) = read_raw(false, name).ok().flatten()?;
        let text = if vtype == REG_EXPAND_SZ {
            expand_percent_vars(&text, &lookup)
        } else {
            text
        };
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_string())
    }

    /// The persisted `Path` of one scope, expanded for handing to a child.
    pub(crate) fn read_scope_path(machine: bool) -> Option<String> {
        let (text, vtype) = read_raw(machine, "Path").ok().flatten()?;
        let text = if vtype == REG_EXPAND_SZ {
            expand_percent_vars(&text, &lookup)
        } else {
            text
        };
        (!text.trim().is_empty()).then_some(text)
    }

    /// The user `Path` exactly as stored, and its type. A missing value reads
    /// as empty, to be created as `REG_EXPAND_SZ` (what Windows itself uses).
    pub(crate) fn read_user_path() -> Result<(String, RegType), String> {
        read_raw(false, "Path")
            .map(|found| found.unwrap_or_else(|| (String::new(), REG_EXPAND_SZ)))
            .map_err(|e| format!("Failed to read the user PATH: {}", e))
    }

    /// Store the user `Path` with the type it was read with, then tell running
    /// programs (Explorer, so new terminals) that the environment changed.
    pub(crate) fn write_user_path(text: &str, vtype: RegType) -> Result<(), String> {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(USER_ENVIRONMENT, KEY_READ | KEY_WRITE)
            .map_err(|e| format!("Failed to open the user environment: {}", e))?;
        key.set_raw_value(
            "Path",
            &RegValue {
                bytes: encode_reg_string(text),
                vtype,
            },
        )
        .map_err(|e| format!("Failed to update the user PATH: {}", e))?;
        // A window that does not answer could hold the broadcast for seconds;
        // nothing here waits on its result.
        std::thread::spawn(broadcast_environment_change);
        Ok(())
    }

    fn broadcast_environment_change() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        let area: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result: usize = 0;
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                area.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }
}

#[cfg(windows)]
pub(crate) use registry::{
    env_lookup, read_scope_path, read_user_env, read_user_path, write_user_path,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn env(name: &str) -> Option<String> {
        match name.to_ascii_uppercase().as_str() {
            "LOCALAPPDATA" => Some(r"C:\Users\Миша\AppData\Local".to_string()),
            "USERPROFILE" => Some(r"C:\Users\Миша".to_string()),
            _ => None,
        }
    }

    const BIN: &str = r"C:\Users\Миша\AppData\Local\Programs\Atomic Chat\resources\bin";

    #[test]
    fn expands_known_references_and_keeps_the_rest_verbatim() {
        assert_eq!(
            expand_percent_vars(r"%USERPROFILE%\.local\bin", &env),
            r"C:\Users\Миша\.local\bin"
        );
        assert_eq!(expand_percent_vars(r"%NOPE%\bin", &env), r"%NOPE%\bin");
        assert_eq!(
            expand_percent_vars(r"50%%USERPROFILE%", &env),
            r"50%C:\Users\Миша"
        );
        assert_eq!(expand_percent_vars("100%", &env), "100%");
        assert_eq!(expand_percent_vars("%%", &env), "%%");
    }

    #[test]
    fn prepending_keeps_every_other_entry_byte_for_byte() {
        let current =
            r"%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\工具\bin;D:\Мои программы";
        let next = path_with_dir_first(current, BIN, &[], &env).unwrap();
        assert_eq!(
            next,
            format!(
                r"{BIN};%USERPROFILE%\AppData\Local\Microsoft\WindowsApps;C:\工具\bin;D:\Мои программы"
            )
        );
    }

    #[test]
    fn prepending_replaces_every_spelling_of_the_dir_and_the_stale_one() {
        let verbatim = format!(r"\\?\{BIN}");
        let via_var = r"%LOCALAPPDATA%\Programs\Atomic Chat\resources\bin\";
        let upper = BIN.to_uppercase();
        let stale = r"C:\Users\Миша\AppData\Local\Programs\Atomic Chat";
        let current = format!(r"C:\a;{verbatim};{via_var};{upper};{stale};C:\b");
        let next = path_with_dir_first(&current, &verbatim, &[stale], &env).unwrap();
        assert_eq!(next, format!(r"{BIN};C:\a;C:\b"));
    }

    #[test]
    fn prepending_reports_no_change_when_the_dir_already_leads() {
        assert_eq!(
            path_with_dir_first(&format!(r"{BIN};C:\a;;C:\b"), BIN, &[], &env),
            None
        );
        assert_eq!(
            path_with_dir_first(r"C:\a", BIN, &[], &env),
            Some(format!(r"{BIN};C:\a"))
        );
        assert_eq!(
            path_with_dir_first("", BIN, &[], &env),
            Some(BIN.to_string())
        );
    }

    #[test]
    fn removing_drops_only_the_dir_and_reports_when_absent() {
        let current = format!(r"%USERPROFILE%\bin;\\?\{BIN};C:\工具");
        assert_eq!(
            path_without_dir(&current, BIN, &env),
            Some(r"%USERPROFILE%\bin;C:\工具".to_string())
        );
        assert_eq!(path_without_dir(r"C:\a;C:\b", BIN, &env), None);
    }

    #[test]
    fn merging_keeps_the_first_spelling_of_each_dir() {
        assert_eq!(
            merge_path_lists(&[r"C:\A; C:\b", r"c:\a;D:\Миша", ""]),
            Some(r"C:\A;C:\b;D:\Миша".to_string())
        );
        assert_eq!(merge_path_lists(&["", " ; "]), None);
    }

    #[test]
    fn registry_strings_round_trip_beyond_the_oem_code_page() {
        let text = r"C:\Users\Миша\bin;C:\工具;%USERPROFILE%\x";
        let bytes = encode_reg_string(text);
        assert_eq!(&bytes[bytes.len() - 2..], &[0, 0]);
        assert_eq!(decode_reg_string(&bytes), text);
        // A payload without its terminator, or with garbage after it.
        let mut unterminated = encode_reg_string("C:\\a");
        unterminated.truncate(unterminated.len() - 2);
        assert_eq!(decode_reg_string(&unterminated), "C:\\a");
        let mut trailing = encode_reg_string("C:\\a");
        trailing.extend_from_slice(&[b'x', 0, b'y', 0]);
        assert_eq!(decode_reg_string(&trailing), "C:\\a");
    }

    #[test]
    fn strips_verbatim_prefixes() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\x"), r"C:\x");
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\srv\share"), r"\\srv\share");
        assert_eq!(strip_verbatim_prefix(r"C:\x"), r"C:\x");
    }
}
