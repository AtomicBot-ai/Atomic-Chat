//! Atomic Chat audio capture and on-device transcription.
//!
//! Records from the microphone in Rust rather than through `getUserMedia`. That
//! buys three things: raw 16 kHz mono PCM without resampling in JavaScript, a
//! working microphone on Linux (WebKitGTK's media capture is unreliable), and
//! an audio path that never crosses the IPC bridge — Tauri v2 serialises
//! `Vec<u8>` as a JSON array of numbers, which would turn every few seconds of
//! speech into hundreds of kilobytes of JSON.
//!
//! Transcription is a POST to the llama.cpp server's OpenAI-compatible
//! `/v1/audio/transcriptions`, which the bundled upstream build already serves.

pub mod capture;
pub mod commands;
pub mod dsp;
pub mod error;
pub mod events;
pub mod permission;
pub mod state;
pub mod transcribe;
pub mod vad;
pub mod wav;

pub use error::{AudioError, AudioErrorCode};
pub use state::AudioState;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, RunEvent, Runtime,
};

/// Initialise the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("atomic-audio")
        .invoke_handler(tauri::generate_handler![
            commands::list_input_devices,
            commands::get_microphone_permission,
            commands::request_microphone_permission,
            commands::start_dictation,
            commands::stop_dictation,
            commands::cancel_dictation,
            commands::get_dictation_status,
            commands::set_transcription_target,
            commands::transcribe_wav,
        ])
        .setup(|app, _api| {
            app.manage(state::AudioState::new());
            Ok(())
        })
        .on_event(|app, event| {
            // A live CoreAudio/WASAPI stream must be torn down before the
            // process goes away, or the OS keeps showing the recording
            // indicator after the window is gone.
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<state::AudioState>() {
                    commands::shutdown(&state);
                }
            }
        })
        .build()
}
