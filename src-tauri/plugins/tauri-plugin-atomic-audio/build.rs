const COMMANDS: &[&str] = &[
    "list_input_devices",
    "get_microphone_permission",
    "request_microphone_permission",
    "start_dictation",
    "stop_dictation",
    "cancel_dictation",
    "get_dictation_status",
    "set_transcription_target",
    "transcribe_wav",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
