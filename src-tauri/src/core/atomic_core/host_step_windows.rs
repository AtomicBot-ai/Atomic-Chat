//! The Windows half of the privileged step (change `add-tensorrt-llm-windows`, design D15): the
//! request folder under `%LOCALAPPDATA%` that only the user, `SYSTEM` and `Administrators` can
//! touch, and the UAC prompt that runs `atomic-chat-core.exe host-step exec <request>` elevated.
//!
//! The elevated process's output is never captured (`ShellExecuteExW` cannot): the result file is
//! its only answer, read by [`super::host_step::elevation_after_runas`] like the Linux one. What
//! decides an outcome lives there, platform-neutral and tested everywhere; this file is only the
//! Win32 calls.

use std::ffi::{c_void, OsStr};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
};
use windows_sys::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
    SHELLEXECUTEINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use super::host_step::{
    elevation_after_runas, request_folder_sddl, runas_parameters, Elevation, HostStep,
    PreparedStep,
};

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// Reads a NUL-terminated UTF-16 string the system allocated, then frees it with `LocalFree`.
unsafe fn take_local_wide(pointer: *mut u16) -> String {
    let mut len = 0;
    while *pointer.add(len) != 0 {
        len += 1;
    }
    let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, len));
    LocalFree(pointer as *mut c_void);
    text
}

/// The SID of the account this app runs as, e.g. `S-1-5-21-…-1001`.
pub fn current_user_sid() -> std::io::Result<String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut needed = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        // `u64` words keep the buffer aligned for `TOKEN_USER`.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8).max(1)];
        let read = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            (buffer.len() * 8) as u32,
            &mut needed,
        );
        let error = std::io::Error::last_os_error();
        CloseHandle(token);
        if read == 0 {
            return Err(error);
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(take_local_wide(text))
    }
}

/// Creates `path` (which must not exist) with the security descriptor `sddl`, in one call: the
/// folder never exists with a wider ACL, not even for a moment.
fn create_dir_with_sddl(path: &Path, sddl: &str) -> std::io::Result<()> {
    unsafe {
        let mut descriptor: *mut c_void = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(OsStr::new(sddl)).as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let created = CreateDirectoryW(wide(path.as_os_str()).as_ptr(), &attributes);
        let error = std::io::Error::last_os_error();
        LocalFree(descriptor);
        if created == 0 {
            return Err(error);
        }
        Ok(())
    }
}

/// Lay the step out in a fresh folder under `root` (`%LOCALAPPDATA%\AtomicChat\host-steps`):
/// the folder with the user-only ACL, the request inside it. `binary` is the bundled executor
/// itself, run in place (design D15).
pub fn prepare(
    root: &Path,
    core_binary: &Path,
    step: &HostStep,
    data_folder: &Path,
) -> std::io::Result<PreparedStep> {
    std::fs::create_dir_all(root)?;
    let dir = root.join(uuid::Uuid::new_v4().simple().to_string());
    create_dir_with_sddl(&dir, &request_folder_sddl(&current_user_sid()?))?;
    let prepared = PreparedStep {
        binary: core_binary.to_path_buf(),
        request: dir.join(format!("{}.request.json", step.step_id)),
        result: dir.join(format!("{}.result.json", step.step_id)),
        dir,
    };
    let written = (|| {
        let requested_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&prepared.request)?;
        file.write_all(step.request(data_folder, requested_at).to_string().as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = written {
        prepared.remove();
        return Err(error);
    }
    Ok(prepared)
}

/// Runs `program parameters` elevated and waits for it: its exit code (`u32::MAX` when it ran but
/// the code could not be read), or the Win32 error when it never started (`ERROR_CANCELLED` when
/// the person said no). `on_started` runs once the person approved UAC and the process started,
/// before the wait: the UI then says the work is under way instead of asking for approval.
/// Blocks; call it off the async runtime.
pub fn run_as_administrator(
    program: &Path,
    parameters: &str,
    on_started: &mut dyn FnMut(),
) -> Result<u32, i32> {
    let verb = wide(OsStr::new("runas"));
    let file = wide(program.as_os_str());
    let parameters = wide(OsStr::new(parameters));
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = parameters.as_ptr();
        // A console program: no window flashes up behind the prompt.
        info.nShow = SW_HIDE;
        if ShellExecuteExW(&mut info) == 0 {
            return Err(GetLastError() as i32);
        }
        on_started();
        if info.hProcess.is_null() {
            // Nothing to wait on; the result file, if any, is the answer.
            return Ok(0);
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 0u32;
        let read = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if read == 0 {
            // The executor did run: its result file is still the answer, never "UAC unavailable".
            log::warn!("[host-step] could not read the executor's exit code: {}", GetLastError());
            return Ok(u32::MAX);
        }
        Ok(code)
    }
}

/// Run the executor through UAC and wait for it; `on_started` as in `run_as_administrator`.
pub fn elevate(prepared: &PreparedStep, on_started: &mut dyn FnMut()) -> Elevation {
    let started = run_as_administrator(&prepared.binary, &runas_parameters(&prepared.request), on_started);
    elevation_after_runas(prepared, started)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step() -> HostStep {
        HostStep::from_operation(&json!({
            "operation_id": "op-w",
            "pending_host_step": {
                "step_id": "step-w",
                "action": "windows.enable-wsl",
                "recipe_id": "windows.enable-wsl",
                "recipe_digest": "sha256:cc",
                "parameters_digest": "sha256:dd",
                "parameters": {},
                "nonce": "n-w",
                "expected_operation_revision": 7
            }
        }))
        .expect("a pending step")
    }

    /// The folder's security descriptor as Windows reports it back.
    fn sddl_of(path: &Path) -> String {
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "(Get-Acl -LiteralPath $env:P).Sddl"])
            .env("P", path)
            .output()
            .expect("powershell");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// How a reported SDDL may spell the user: Windows writes the built-in Administrator
    /// (RID 500, the account GitHub's Windows runners run as) as its alias `LA`, any other
    /// account as its SID.
    fn sddl_names(sid: &str) -> Vec<String> {
        let mut names = vec![sid.to_string()];
        if sid.ends_with("-500") {
            names.push("LA".to_string());
        }
        names
    }

    #[test]
    fn the_user_sid_is_a_string_sid() {
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-5-"), "{sid}");
    }

    #[test]
    fn lays_out_a_request_in_a_folder_only_the_user_system_and_administrators_can_touch() {
        let root = tempfile::tempdir().unwrap();
        let core = root.path().join("atomic-chat-core.exe");
        std::fs::write(&core, b"").unwrap();

        let prepared = prepare(&root.path().join("host-steps"), &core, &step(), Path::new(r"C:\data")).unwrap();

        assert!(prepared.dir.starts_with(root.path().join("host-steps")));
        assert_eq!(prepared.binary, core, "run in place, never copied");
        assert_eq!(prepared.request.file_name().unwrap(), "step-w.request.json");
        assert_eq!(prepared.result.file_name().unwrap(), "step-w.result.json");

        let user = sddl_names(&current_user_sid().unwrap());
        let sddl = sddl_of(&prepared.dir);
        let owner = sddl.strip_prefix("O:").and_then(|rest| rest.split("G:").next()).unwrap_or_default();
        assert!(user.iter().any(|name| name == owner), "the owner is the user: {sddl}");
        assert!(sddl.contains("D:P"), "the DACL is protected from inheritance: {sddl}");
        let trustees: Vec<&str> = sddl
            .split('(')
            .skip(1)
            .map(|ace| ace.trim_end_matches(')').rsplit(';').next().unwrap_or_default())
            .collect();
        for trustee in &trustees {
            assert!(
                user.iter().any(|name| name == trustee) || *trustee == "SY" || *trustee == "BA",
                "an entry for {trustee} in {sddl}"
            );
        }
        // The request inherits the folder's entries, nothing wider.
        let file = sddl_of(&prepared.request);
        assert!(!file.contains(";WD)") && !file.contains(";BU)") && !file.contains(";AU)"), "{file}");

        let request: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&prepared.request).unwrap()).unwrap();
        assert_eq!(request["action"], "windows.enable-wsl");
        assert_eq!(request["parameters"], json!({}));
        assert_eq!(request["data_folder"], r"C:\data");

        prepared.remove();
        assert!(!prepared.dir.exists());
    }

    #[test]
    fn two_steps_never_share_a_folder() {
        let root = tempfile::tempdir().unwrap();
        let core = root.path().join("atomic-chat-core.exe");
        std::fs::write(&core, b"").unwrap();
        let first = prepare(root.path(), &core, &step(), Path::new(r"C:\data")).unwrap();
        let second = prepare(root.path(), &core, &step(), Path::new(r"C:\data")).unwrap();
        assert_ne!(first.dir, second.dir);
    }
}
