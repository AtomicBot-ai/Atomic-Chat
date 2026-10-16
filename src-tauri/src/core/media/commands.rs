//! Tauri commands for media provider credentials.
//!
//! Desktop only, and deliberately the narrowest surface that works: set, get,
//! delete, plus one question about whether storage exists at all.
//!
//! There is no "list all credentials" command. Enumeration would let anything
//! able to invoke a command sweep every key the user has stored, which is a
//! capability the app itself does not need — the frontend always knows the
//! `setting_key` it is asking about, because the provider descriptor carries it.

use super::secrets::{os::OsCredentialStore, CredentialError, CredentialStore};

/// Errors cross the IPC boundary as strings, so this is where the shape is
/// fixed. `Display` on `CredentialError` never includes the secret.
fn describe(error: CredentialError) -> String {
    error.to_string()
}

#[tauri::command]
pub fn media_secret_set(key: String, secret: String) -> Result<(), String> {
    OsCredentialStore.set(&key, &secret).map_err(describe)
}

#[tauri::command]
pub fn media_secret_get(key: String) -> Result<Option<String>, String> {
    OsCredentialStore.get(&key).map_err(describe)
}

#[tauri::command]
pub fn media_secret_delete(key: String) -> Result<(), String> {
    OsCredentialStore.delete(&key).map_err(describe)
}

/// Whether this machine has a usable credential store.
///
/// Exists so the settings UI can say "credential storage is unavailable on this
/// system" up front, instead of accepting a key, appearing to save it, and then
/// failing to authenticate later. The expected false case is Linux without a
/// Secret Service provider.
///
/// Probes with a read of a key that is never written, because a write probe
/// would leave a stray credential behind on the user's machine.
#[tauri::command]
pub fn media_secret_available() -> bool {
    OsCredentialStore
        .get("media.__availability_probe__.api_key")
        .is_ok()
}
