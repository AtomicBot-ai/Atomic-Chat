//! Stitch continuous-session clips into one video with the system `ffmpeg`.
//!
//! Radium does not bundle ffmpeg; this uses one found on PATH (the same
//! approach as the agent's video tools). When none is present the frontend
//! keeps the clips separately. The concat demuxer with stream copy is tried
//! first (clips from one model share codec and size); if that fails the clips
//! are re-encoded to H.264.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

pub(crate) fn locate_ffmpeg(path_value: Option<&OsStr>) -> Option<PathBuf> {
    let path_value = path_value?;
    std::env::split_paths(path_value)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(binary_name()))
        .find(|candidate| candidate.is_file())
}

/// The concat list file contents. Single quotes are escaped the way ffmpeg's
/// concat demuxer expects (`'\''`).
pub(crate) fn concat_list(inputs: &[String]) -> String {
    inputs
        .iter()
        .map(|path| format!("file '{}'\n", path.replace('\'', "'\\''")))
        .collect()
}

fn run(ffmpeg: &Path, list: &Path, output: &str, copy: bool) -> Result<(), String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(list);
    if copy {
        command.args(["-c", "copy"]);
    } else {
        command.args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]);
    }
    let result = command.arg(output).output().map_err(|e| e.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).trim().to_string())
    }
}

#[tauri::command]
pub fn media_ffmpeg_available() -> bool {
    locate_ffmpeg(std::env::var_os("PATH").as_deref()).is_some()
}

#[tauri::command]
pub async fn media_stitch_videos(inputs: Vec<String>, output: String) -> Result<String, String> {
    if inputs.is_empty() {
        return Err("No clips to stitch.".into());
    }
    let ffmpeg = locate_ffmpeg(std::env::var_os("PATH").as_deref())
        .ok_or_else(|| "ffmpeg was not found on PATH".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let list = PathBuf::from(format!("{output}.concat.txt"));
        std::fs::write(&list, concat_list(&inputs)).map_err(|e| e.to_string())?;
        let result = run(&ffmpeg, &list, &output, true).or_else(|_| run(&ffmpeg, &list, &output, false));
        let _ = std::fs::remove_file(&list);
        result.map(|_| output)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concat_list_escapes_quotes() {
        let list = concat_list(&["/a/b.mp4".into(), "/x/it's.mp4".into()]);
        assert_eq!(list, "file '/a/b.mp4'\nfile '/x/it'\\''s.mp4'\n");
    }

    #[test]
    fn locate_ffmpeg_none_without_path() {
        assert!(locate_ffmpeg(None).is_none());
    }
}
