//! Live status rows for the macOS menu-bar tray: server URL, current model, RAM bar.
//!
//! The menu rows themselves are created in [`crate::core::setup::setup_tray`]; handles
//! to the mutable rows are stashed in [`crate::core::state::AppState::tray_handles`] so
//! the `update_tray_status` command can re-render text + leading icons each tick.
//!
//! Updates are driven from the frontend ([`web-app/src/hooks/useTrayStatusSync.ts`]) on
//! a 5 s cadence so all state (server status, active models, hardware usage) can stay in
//! a single place without introducing a new Rust polling loop.

#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{IconMenuItem, MenuItem},
    AppHandle, Manager, Wry,
};

/// Handles to the live rows in the tray menu. Stored in `AppState`.
///
/// The RAM indicator is intentionally split into two rows (text above, bar
/// below) so the bar row is the only thing driving menu width — matching the
/// compact Pico AI Server panel look instead of stretching across the screen.
#[cfg(desktop)]
pub struct TrayHandles {
    pub server: IconMenuItem<Wry>,
    pub model: MenuItem<Wry>,
    pub ram_text: MenuItem<Wry>,
    pub ram_bar: IconMenuItem<Wry>,
    /// Last known server URL (kept so `Copy API URL` works even when the row
    /// currently renders "— stopped —").
    pub server_url: Mutex<String>,
}

#[cfg(desktop)]
#[derive(Debug, serde::Deserialize)]
pub struct TrayStatusPayload {
    pub server_running: bool,
    pub server_url: String,
    pub model_label: String,
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    pub ram_percent: u8,
}

// ---------- Icon rendering helpers ----------------------------------------------------

#[cfg(desktop)]
const DOT_SIZE: u32 = 16;
/// Width of the stand-alone RAM bar row. Chosen to drive overall menu width
/// to roughly Pico AI Server's panel — narrow enough to not stretch the menu
/// across the screen, wide enough that the fill percentage is readable.
#[cfg(desktop)]
const BAR_WIDTH: u32 = 220;
#[cfg(desktop)]
const BAR_HEIGHT: u32 = 10;
#[cfg(desktop)]
const BAR_RADIUS: f32 = 3.0;

#[cfg(desktop)]
#[inline]
fn put_pixel(buf: &mut [u8], x: u32, y: u32, width: u32, r: u8, g: u8, b: u8, a: u8) {
    let idx = ((y * width + x) * 4) as usize;
    buf[idx] = r;
    buf[idx + 1] = g;
    buf[idx + 2] = b;
    buf[idx + 3] = a;
}

/// 16x16 filled circle. Green when `running`, neutral gray otherwise.
#[cfg(desktop)]
pub fn render_dot(running: bool) -> Image<'static> {
    let (r, g, b) = if running {
        (0x22, 0xc5, 0x5e) // emerald-500
    } else {
        (0x6b, 0x72, 0x80) // slate-500
    };

    let size = DOT_SIZE;
    let mut buf = vec![0u8; (size * size * 4) as usize];
    let center = (size as f32 - 1.0) / 2.0;
    let radius = size as f32 / 2.0 - 0.5;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            // Soft 1 px AA at the edge.
            let alpha = if dist <= radius - 1.0 {
                255.0
            } else if dist <= radius {
                (1.0 - (dist - (radius - 1.0))) * 255.0
            } else {
                0.0
            };
            if alpha > 0.0 {
                put_pixel(&mut buf, x, y, size, r, g, b, alpha.round() as u8);
            }
        }
    }

    Image::new_owned(buf, size, size)
}

/// 160x10 rounded-corner progress bar. Track is a faint gray rail; the fill is
/// a horizontal blue->pink gradient mirroring the Pico AI Server aesthetic.
#[cfg(desktop)]
pub fn render_bar(percent: u8) -> Image<'static> {
    let pct = (percent.min(100)) as f32 / 100.0;
    let w = BAR_WIDTH;
    let h = BAR_HEIGHT;
    let mut buf = vec![0u8; (w * h * 4) as usize];

    // Colors.
    let track = (0x3a, 0x3a, 0x3a, 96u8);
    let start = (0x3b, 0x82, 0xf6); // blue-500
    let end = (0xec, 0x48, 0x99); // pink-500

    let fill_end = pct * w as f32;

    for y in 0..h {
        for x in 0..w {
            // Rounded rect mask: compute distance to the nearest inner corner.
            let fx = x as f32;
            let fy = y as f32;
            let r = BAR_RADIUS;
            // Inset corner centers.
            let cx = fx.max(r).min(w as f32 - 1.0 - r);
            let cy = fy.max(r).min(h as f32 - 1.0 - r);
            let dx = fx - cx;
            let dy = fy - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let mask_alpha = if dist <= r - 1.0 {
                1.0
            } else if dist <= r {
                1.0 - (dist - (r - 1.0))
            } else {
                0.0
            };
            if mask_alpha <= 0.0 {
                continue;
            }

            // Track colour everywhere, fill gradient up to fill_end.
            let (mut r_, mut g_, mut b_, mut a_) = track;
            if (x as f32) < fill_end {
                let t = if w > 1 {
                    x as f32 / (w as f32 - 1.0)
                } else {
                    0.0
                };
                r_ = (start.0 as f32 + (end.0 as f32 - start.0 as f32) * t) as u8;
                g_ = (start.1 as f32 + (end.1 as f32 - start.1 as f32) * t) as u8;
                b_ = (start.2 as f32 + (end.2 as f32 - start.2 as f32) * t) as u8;
                a_ = 255;
            }

            let final_a = ((a_ as f32) * mask_alpha).round() as u8;
            put_pixel(&mut buf, x, y, w, r_, g_, b_, final_a);
        }
    }

    Image::new_owned(buf, w, h)
}

// ---------- Command -------------------------------------------------------------------

#[cfg(desktop)]
#[tauri::command]
pub async fn update_tray_status(app: AppHandle, payload: TrayStatusPayload) -> Result<(), String> {
    let state = app.state::<crate::core::state::AppState>();
    let guard = state.tray_handles.lock().map_err(|e| e.to_string())?;
    let Some(handles) = guard.as_ref() else {
        // Tray not installed (non-macOS without ENABLE_SYSTEM_TRAY_ICON, or setup failed).
        return Ok(());
    };

    // Server row text + dot.
    let server_text = if payload.server_running {
        format!("Server  {}", payload.server_url)
    } else {
        "Server  — stopped —".to_string()
    };
    handles
        .server
        .set_text(&server_text)
        .map_err(|e| e.to_string())?;
    handles
        .server
        .set_icon(Some(render_dot(payload.server_running)))
        .map_err(|e| e.to_string())?;

    // Keep last non-empty URL around for Copy API URL.
    if !payload.server_url.is_empty() {
        if let Ok(mut u) = handles.server_url.lock() {
            *u = payload.server_url.clone();
        }
    }

    // Model row text (no icon).
    let model_text = if payload.model_label.trim().is_empty() {
        "Model  — no model loaded —".to_string()
    } else {
        format!("Model  {}", payload.model_label)
    };
    handles
        .model
        .set_text(&model_text)
        .map_err(|e| e.to_string())?;

    // RAM: text row above, bar row below. Splitting them keeps the menu
    // width driven only by BAR_WIDTH + OS padding instead of bar + long text.
    let used_gb = payload.ram_used_mb as f64 / 1024.0;
    let total_gb = payload.ram_total_mb as f64 / 1024.0;
    let ram_text = format!(
        "RAM  {:.1} / {:.1} GB  ·  {}%",
        used_gb, total_gb, payload.ram_percent
    );
    handles
        .ram_text
        .set_text(&ram_text)
        .map_err(|e| e.to_string())?;
    handles
        .ram_bar
        .set_icon(Some(render_bar(payload.ram_percent)))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// No-op on mobile — the frontend hook is gated to Tauri desktop but we keep the
/// symbol registered so `generate_handler!` lists stay aligned.
#[cfg(not(desktop))]
#[tauri::command]
pub async fn update_tray_status(_payload: serde_json::Value) -> Result<(), String> {
    Ok(())
}

// ---------- Clipboard helper used by the "Copy API URL" menu item ---------------------

/// Write the given text to the system clipboard.
///
/// On macOS this shells out to `pbcopy` to avoid pulling in
/// `tauri-plugin-clipboard-manager` purely for this one feature. On other
/// desktops the tray is env-gated and currently opt-in, so this path stays
/// a best-effort fallback there.
#[cfg(desktop)]
pub fn write_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn pbcopy: {e}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("write pbcopy stdin: {e}"))?;
        }
        child.wait().map_err(|e| format!("wait pbcopy: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        // Try xclip first, fall back to xsel.
        let try_cmd = |program: &str, args: &[&str]| -> Result<(), String> {
            let mut child = Command::new(program)
                .args(args)
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|e| format!("spawn {program}: {e}"))?;
            if let Some(stdin) = child.stdin.as_mut() {
                stdin
                    .write_all(text.as_bytes())
                    .map_err(|e| format!("write {program} stdin: {e}"))?;
            }
            child.wait().map_err(|e| format!("wait {program}: {e}"))?;
            Ok(())
        };
        try_cmd("xclip", &["-selection", "clipboard"])
            .or_else(|_| try_cmd("xsel", &["--clipboard", "--input"]))
    }

    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("cmd")
            .args(["/C", "clip"])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn clip: {e}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("write clip stdin: {e}"))?;
        }
        child.wait().map_err(|e| format!("wait clip: {e}"))?;
        Ok(())
    }
}
