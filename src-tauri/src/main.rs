// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let _ = fix_path_env::fix();

    // ATO-113: bring up Sentry as early as possible so the panic hook is armed
    // before any work happens. The guard must live for the whole process (it
    // flushes pending events on drop), so it is held until `main` returns.
    // No-op when no DSN was baked in (e.g. local dev builds).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _sentry_guard = app_lib::core::telemetry::init();

    // ATO-386: log panics to app.log before chaining to the previous hook
    // (Sentry or the default Rust hook). The tauri-plugin-log logger is not yet
    // installed here, but the hook is global, so once logging is set up in
    // `setup()` every subsequent panic is written to the log file as well as
    // sent to telemetry.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let default_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = info.payload();
            let message = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic payload".to_string());
            log::error!("Application panic: {message}");
            if let Some(location) = info.location() {
                log::error!(
                    "Panic location: {}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                );
            }
            default_hook(info);
        }));
    }

    // Ensure localhost bypasses any configured HTTP/SOCKS proxy.
    // Without this, the Tauri HTTP plugin (reqwest) picks up the macOS
    // system proxy and routes local llama-server requests through it,
    // which breaks communication with the local inference backend.
    let local_hosts = "localhost,127.0.0.1,::1,0.0.0.0";
    for key in &["NO_PROXY", "no_proxy"] {
        match std::env::var(key) {
            Ok(existing) if !existing.is_empty() => {
                std::env::set_var(key, format!("{},{}", existing, local_hosts));
            }
            _ => {
                std::env::set_var(key, local_hosts);
            }
        }
    }

    // Normal Tauri app startup
    app_lib::run();
}
