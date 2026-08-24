//! Host-CLI media tools: local audio transcription (whisper) and YouTube
//! transcript/frame retrieval (yt-dlp + ffmpeg).
//!
//! Both tools degrade gracefully when the backing CLI is missing from PATH:
//! they return a one-line error naming the missing binary and an install hint
//! the model can relay to the user. Oversized transcripts are handled by the
//! observation spill policy (`os.media.*` is spill-eligible).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Output;

use serde_json::Value;
use tokio::process::Command;

use super::{optional_usize, required_string, resolve_path, ToolContext};
use crate::core::agent::types::{ToolOutcome, ToolStatus};

/// Workspace-relative directory that holds produced transcripts.
const TRANSCRIPTS_DIR: &str = ".agent/transcripts";
/// Workspace-relative directory that holds YouTube subtitles and downloads.
const YOUTUBE_DIR: &str = ".agent/youtube";
/// Generous ceiling for media CLI runs (transcription and downloads are slow).
const MEDIA_COMMAND_TIMEOUT_MS: u64 = 300_000;
/// Chars of stderr surfaced in error summaries.
const MAX_STDERR_TAIL_CHARS: usize = 400;
/// Whisper binaries probed on PATH, in preference order. `whisper-cli` is the
/// whisper.cpp CLI; `whisper` is the openai-whisper Python CLI.
const WHISPER_BINARIES: &[&str] = &["whisper-cli", "whisper"];
const WHISPER_INSTALL_HINT: &str =
    "install one with `brew install whisper-cpp` or `pip install openai-whisper` (needs ffmpeg)";
const YT_DLP_INSTALL_HINT: &str = "install it with `brew install yt-dlp` or `pip install yt-dlp`";
const FFMPEG_INSTALL_HINT: &str = "install it with `brew install ffmpeg`";
/// One frame every five seconds of video.
const FRAME_SAMPLING_FILTER: &str = "fps=1/5";
const DEFAULT_MAX_FRAMES: usize = 8;
const MAX_FRAMES: usize = 16;

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "os.media.transcribe" => transcribe(args, context).await,
        "os.media.youtube" => youtube(args, context).await,
        _ => Err(ToolOutcome::error(format!("Unsupported media tool: {tool}"))),
    }
}

async fn transcribe(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let path = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let language = optional_string(args, "language")?;
    tokio::fs::metadata(&path)
        .await
        .map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
    let whisper = require_binary(
        WHISPER_BINARIES,
        std::env::var_os("PATH").as_deref(),
        WHISPER_INSTALL_HINT,
    )?;
    let transcripts_dir = ensure_dir(context.working_dir, TRANSCRIPTS_DIR).await?;
    let stem = file_stem(&path);
    let transcript_path = transcripts_dir.join(format!("{stem}.txt"));
    let mut command = Command::new(&whisper);
    command.args(whisper_arguments(
        &whisper,
        &path,
        &transcripts_dir,
        &stem,
        language.as_deref(),
    ));
    let output = run_media_command(command, "Transcription", context).await?;
    if !output.status.success() {
        return Err(ToolOutcome::error(format!(
            "Transcription failed with {}: {}",
            output.status,
            stderr_tail(&output)
        )));
    }
    let text = tokio::fs::read_to_string(&transcript_path)
        .await
        .map_err(|error| {
            ToolOutcome::error(format!(
                "Transcription produced no transcript at {}: {error}; {}",
                transcript_path.display(),
                stderr_tail(&output)
            ))
        })?;
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err(ToolOutcome::error(
            "Transcription produced an empty transcript",
        ));
    }
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: text,
        details: Some(serde_json::json!({
            "transcriptPath": transcript_path.to_string_lossy(),
            "binary": whisper.to_string_lossy(),
        })),
    })
}

/// Arguments for the located whisper binary. The whisper.cpp CLI
/// (`whisper-cli`) and the openai-whisper Python CLI (`whisper`) accept
/// different flags but both can be pointed at a text transcript in
/// `transcripts_dir` named `<stem>.txt`.
fn whisper_arguments(
    binary: &Path,
    audio: &Path,
    transcripts_dir: &Path,
    stem: &str,
    language: Option<&str>,
) -> Vec<std::ffi::OsString> {
    let mut arguments: Vec<std::ffi::OsString> = Vec::new();
    if uses_whisper_cpp_interface(binary) {
        arguments.push("-f".into());
        arguments.push(audio.into());
        arguments.push("-otxt".into());
        arguments.push("-of".into());
        arguments.push(transcripts_dir.join(stem).into());
        if let Some(language) = language {
            arguments.push("-l".into());
            arguments.push(language.into());
        }
    } else {
        arguments.push(audio.into());
        arguments.push("--output_format".into());
        arguments.push("txt".into());
        arguments.push("--output_dir".into());
        arguments.push(transcripts_dir.into());
        if let Some(language) = language {
            arguments.push("--language".into());
            arguments.push(language.into());
        }
    }
    arguments
}

fn uses_whisper_cpp_interface(binary: &Path) -> bool {
    binary
        .file_stem()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name == "whisper-cli")
}

async fn youtube(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let url = required_string(args, "url").map_err(ToolOutcome::error)?;
    validate_youtube_url(&url).map_err(ToolOutcome::error)?;
    // Isolate every call in its own subdirectory so a "newest file" scan can
    // only ever see this call's output — never a prior call's subtitles or a
    // concurrent call's video (both tools are PureRead and may run in parallel).
    let call_dir = ensure_dir(
        context.working_dir,
        &format!("{YOUTUBE_DIR}/{}", uuid::Uuid::new_v4()),
    )
    .await?;
    match parse_youtube_mode(args).map_err(ToolOutcome::error)? {
        YoutubeMode::Transcript => youtube_transcript(&url, &call_dir, context).await,
        YoutubeMode::Frames => youtube_frames(&url, &call_dir, args, context).await,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum YoutubeMode {
    Transcript,
    Frames,
}

fn parse_youtube_mode(args: &Value) -> Result<YoutubeMode, String> {
    match args
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("transcript")
    {
        "transcript" => Ok(YoutubeMode::Transcript),
        "frames" => Ok(YoutubeMode::Frames),
        value => Err(format!(
            "Invalid mode `{value}`; expected `transcript` or `frames`"
        )),
    }
}

/// Hosts accepted for `os.media.youtube`. The check is on the parsed URL host,
/// not a substring: `https://10.0.0.5/?ref=youtu.be/x` must NOT pass, or the
/// tool becomes an SSRF primitive (it shells out to yt-dlp, which has no
/// network guard of its own).
const ALLOWED_YOUTUBE_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
];

fn validate_youtube_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| format!("`url` is not a valid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("`url` must use http or https: {url}"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| format!("`url` has no host: {url}"))?
        .to_ascii_lowercase();
    if !ALLOWED_YOUTUBE_HOSTS.contains(&host.as_str()) {
        return Err(format!(
            "`url` host `{host}` is not a YouTube host; expected one of {ALLOWED_YOUTUBE_HOSTS:?}"
        ));
    }
    Ok(())
}

async fn youtube_transcript(
    url: &str,
    youtube_dir: &Path,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let yt_dlp = require_binary(
        &["yt-dlp"],
        std::env::var_os("PATH").as_deref(),
        YT_DLP_INSTALL_HINT,
    )?;
    let mut command = Command::new(&yt_dlp);
    command
        .arg("--skip-download")
        .arg("--write-auto-subs")
        .arg("--write-subs")
        .arg("--sub-langs")
        .arg("en.*,en")
        .arg("--sub-format")
        .arg("vtt")
        .arg("-o")
        .arg(youtube_dir.join("%(id)s"))
        .arg(url);
    let output = run_media_command(command, "YouTube subtitle download", context).await?;
    if !output.status.success() {
        return Err(ToolOutcome::error(format!(
            "YouTube subtitle download failed with {}: {}",
            output.status,
            stderr_tail(&output)
        )));
    }
    let subtitle_path = newest_file_with_extension(youtube_dir, "vtt")
        .await?
        .ok_or_else(|| {
            ToolOutcome::error(format!(
                "No English subtitles were produced for {url}; the video may have no captions. {}",
                stderr_tail(&output)
            ))
        })?;
    let raw = tokio::fs::read_to_string(&subtitle_path)
        .await
        .map_err(|error| {
            ToolOutcome::error(format!("{}: {error}", subtitle_path.display()))
        })?;
    let transcript = parse_vtt_transcript(&raw);
    if transcript.is_empty() {
        return Err(ToolOutcome::error(
            "Subtitles contained no transcript text",
        ));
    }
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: transcript,
        details: Some(serde_json::json!({
            "url": url,
            "subtitlePath": subtitle_path.to_string_lossy(),
        })),
    })
}

async fn youtube_frames(
    url: &str,
    youtube_dir: &Path,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let path_value = std::env::var_os("PATH");
    let yt_dlp = require_binary(&["yt-dlp"], path_value.as_deref(), YT_DLP_INSTALL_HINT)?;
    let ffmpeg = require_binary(&["ffmpeg"], path_value.as_deref(), FFMPEG_INSTALL_HINT)?;
    let max_frames = optional_usize(args, "maxFrames", DEFAULT_MAX_FRAMES, MAX_FRAMES);
    let mut command = Command::new(&yt_dlp);
    command
        .arg("-f")
        .arg("worst[ext=mp4]/worst")
        .arg("--no-simulate")
        .arg("--print")
        .arg("after_move:filepath")
        .arg("-o")
        .arg(youtube_dir.join("%(id)s.%(ext)s"))
        .arg(url);
    let output = run_media_command(command, "YouTube video download", context).await?;
    if !output.status.success() {
        return Err(ToolOutcome::error(format!(
            "YouTube video download failed with {}: {}",
            output.status,
            stderr_tail(&output)
        )));
    }
    let video_path = downloaded_video_path(&output, youtube_dir).await?;
    let video_id = file_stem(&video_path);
    let frames_dir = youtube_dir.join("frames").join(&video_id);
    tokio::fs::create_dir_all(&frames_dir).await.map_err(|error| {
        ToolOutcome::error(format!("Could not create {}: {error}", frames_dir.display()))
    })?;
    let mut command = Command::new(&ffmpeg);
    command
        .arg("-y")
        .arg("-i")
        .arg(&video_path)
        .arg("-vf")
        .arg(FRAME_SAMPLING_FILTER)
        .arg("-frames:v")
        .arg(max_frames.to_string())
        .arg(frames_dir.join("frame-%03d.jpg"));
    let output = run_media_command(command, "Frame extraction", context).await?;
    if !output.status.success() {
        return Err(ToolOutcome::error(format!(
            "Frame extraction failed with {}: {}",
            output.status,
            stderr_tail(&output)
        )));
    }
    let mut frame_paths = Vec::new();
    for index in 1..=max_frames {
        let frame = frames_dir.join(format!("frame-{index:03}.jpg"));
        if tokio::fs::metadata(&frame).await.is_ok() {
            frame_paths.push(frame.to_string_lossy().into_owned());
        }
    }
    if frame_paths.is_empty() {
        return Err(ToolOutcome::error(format!(
            "Frame extraction produced no frames: {}",
            stderr_tail(&output)
        )));
    }
    let summary = format!(
        "Extracted {} frame(s) sampled every 5 seconds from {url}:\n{}\nInspect them in batches with vision.describe (up to 4 images per call).",
        frame_paths.len(),
        frame_paths.join("\n"),
    );
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary,
        details: Some(serde_json::json!({
            "url": url,
            "videoPath": video_path.to_string_lossy(),
            "framePaths": frame_paths,
        })),
    })
}

/// The final video path: yt-dlp prints it via `--print after_move:filepath`;
/// fall back to the newest video file in the download directory when the
/// printed path is absent or stale.
async fn downloaded_video_path(
    output: &Output,
    youtube_dir: &Path,
) -> Result<PathBuf, ToolOutcome> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(line) = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
    {
        let candidate = PathBuf::from(line);
        if tokio::fs::metadata(&candidate).await.is_ok() {
            return Ok(candidate);
        }
    }
    for extension in ["mp4", "webm", "mkv"] {
        if let Some(path) = newest_file_with_extension(youtube_dir, extension).await? {
            return Ok(path);
        }
    }
    Err(ToolOutcome::error(format!(
        "YouTube download reported success but no video file was found in {}",
        youtube_dir.display()
    )))
}

/// Extract the spoken-text lines from a WebVTT document: drops the header and
/// metadata, cue timing lines (with their cue settings), and inline tags like
/// `<00:00:01.000>` / `<c>...</c>`, then collapses consecutive duplicate lines
/// (auto-generated captions repeat lines heavily).
fn parse_vtt_transcript(vtt: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw_line in vtt.lines() {
        let stripped = decode_basic_entities(&strip_inline_tags(raw_line));
        let line = stripped.trim();
        if line.is_empty()
            || line == "WEBVTT"
            || line.starts_with("WEBVTT ")
            || line.starts_with("Kind:")
            || line.starts_with("Language:")
            || line.starts_with("NOTE")
            || line.starts_with("STYLE")
            || line.contains("-->")
        {
            continue;
        }
        if lines.last().map(String::as_str) != Some(line) {
            lines.push(line.to_owned());
        }
    }
    lines.join("\n")
}

/// Remove `<...>` spans (timestamps, `<c>` styling) from one cue line.
fn strip_inline_tags(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_tag = false;
    for ch in line.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            _ => out.push(ch),
        }
    }
    out
}

fn decode_basic_entities(line: &str) -> String {
    line.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// Locate the first of `names` (in preference order) on the given PATH value.
/// The PATH is injectable so the not-installed error path is unit-testable.
fn locate_binary(names: &[&str], path_value: Option<&OsStr>) -> Option<PathBuf> {
    let path_value = path_value?;
    for name in names {
        for dir in std::env::split_paths(path_value) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let candidate = dir.join(binary_file_name(name));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn require_binary(
    names: &[&str],
    path_value: Option<&OsStr>,
    install_hint: &str,
) -> Result<PathBuf, ToolOutcome> {
    locate_binary(names, path_value)
        .ok_or_else(|| ToolOutcome::error(missing_binary_message(names, install_hint)))
}

fn missing_binary_message(names: &[&str], install_hint: &str) -> String {
    let tried = names
        .iter()
        .map(|name| format!("`{name}`"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("Missing required CLI: {tried} not found on PATH; {install_hint}")
}

#[cfg(windows)]
fn binary_file_name(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(windows))]
fn binary_file_name(name: &str) -> String {
    name.to_owned()
}

async fn run_media_command(
    mut command: Command,
    label: &str,
    context: &ToolContext<'_>,
) -> Result<Output, ToolOutcome> {
    command
        .current_dir(context.working_dir)
        .kill_on_drop(true);
    tokio::select! {
        _ = context.cancellation.cancelled() => Err(ToolOutcome {
            status: ToolStatus::Cancelled,
            summary: format!("{label} cancelled"),
            details: None,
        }),
        result = tokio::time::timeout(
            std::time::Duration::from_millis(MEDIA_COMMAND_TIMEOUT_MS),
            command.output(),
        ) => result
            .map_err(|_| {
                ToolOutcome::error(format!(
                    "{label} timed out after {MEDIA_COMMAND_TIMEOUT_MS}ms"
                ))
            })?
            .map_err(|error| ToolOutcome::error(format!("{label} could not start: {error}"))),
    }
}

async fn ensure_dir(working_dir: &Path, relative: &str) -> Result<PathBuf, ToolOutcome> {
    let dir = working_dir.join(relative);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| ToolOutcome::error(format!("Could not create {}: {error}", dir.display())))?;
    Ok(dir)
}

async fn newest_file_with_extension(
    dir: &Path,
    extension: &str,
) -> Result<Option<PathBuf>, ToolOutcome> {
    let mut entries = tokio::fs::read_dir(dir)
        .await
        .map_err(|error| ToolOutcome::error(format!("{}: {error}", dir.display())))?;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    loop {
        let entry = entries
            .next_entry()
            .await
            .map_err(|error| ToolOutcome::error(format!("{}: {error}", dir.display())))?;
        let Some(entry) = entry else { break };
        let path = entry.path();
        if path.extension().and_then(OsStr::to_str) != Some(extension) {
            continue;
        }
        let modified = entry
            .metadata()
            .await
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if newest
            .as_ref()
            .is_none_or(|(newest_modified, _)| modified >= *newest_modified)
        {
            newest = Some((modified, path));
        }
    }
    Ok(newest.map(|(_, path)| path))
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "media".to_owned())
}

fn stderr_tail(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return "(no stderr output)".to_owned();
    }
    let count = trimmed.chars().count();
    if count <= MAX_STDERR_TAIL_CHARS {
        return trimmed.to_owned();
    }
    let tail: String = trimmed.chars().skip(count - MAX_STDERR_TAIL_CHARS).collect();
    format!("[...] {tail}")
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, ToolOutcome> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(ToolOutcome::error(format!(
            "`{key}` must be a non-empty string"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_auto_sub_vtt_dropping_header_timings_tags_and_duplicates() {
        let vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.320 --> 00:00:02.879 align:start position:0%\n \nso<00:00:00.799><c> today</c><00:00:01.040><c> we</c>\n\n00:00:02.879 --> 00:00:05.190 align:start position:0%\nso today we\nare<00:00:03.360><c> testing</c>\n";
        assert_eq!(parse_vtt_transcript(vtt), "so today we\nare testing");
    }

    #[test]
    fn keeps_non_consecutive_repeats_and_decodes_basic_entities() {
        let vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nrock &amp; roll\n\n00:00:01.000 --> 00:00:02.000\nchorus\n\n00:00:02.000 --> 00:00:03.000\nrock &amp; roll\n";
        assert_eq!(
            parse_vtt_transcript(vtt),
            "rock & roll\nchorus\nrock & roll"
        );
    }

    #[test]
    fn strips_inline_timestamp_and_styling_tags() {
        assert_eq!(
            strip_inline_tags("are<00:00:03.360><c> testing</c> now"),
            "are testing now"
        );
        assert_eq!(strip_inline_tags("no tags at all"), "no tags at all");
    }

    #[test]
    fn empty_vtt_yields_an_empty_transcript() {
        assert_eq!(parse_vtt_transcript("WEBVTT\nKind: captions\n"), "");
    }

    #[test]
    fn locator_finds_nothing_on_an_empty_path_override() {
        assert_eq!(
            locate_binary(WHISPER_BINARIES, Some(OsStr::new(""))),
            None
        );
        assert_eq!(locate_binary(&["yt-dlp"], None), None);
    }

    #[test]
    fn missing_binary_error_names_every_candidate_and_the_install_hint() {
        let outcome = require_binary(
            WHISPER_BINARIES,
            Some(OsStr::new("")),
            WHISPER_INSTALL_HINT,
        )
        .unwrap_err();
        assert_eq!(outcome.status, ToolStatus::Error);
        assert!(outcome.summary.contains("`whisper-cli`"));
        assert!(outcome.summary.contains("`whisper`"));
        assert!(outcome.summary.contains("brew install"));
        assert!(outcome.summary.lines().count() == 1);
    }

    #[test]
    fn locator_prefers_earlier_names_across_the_whole_path() {
        let parent = std::env::temp_dir().join(format!("atomic-chat-media-{}", uuid::Uuid::new_v4()));
        let first = parent.join("first");
        let second = parent.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join(binary_file_name("whisper")), "").unwrap();
        std::fs::write(second.join(binary_file_name("whisper-cli")), "").unwrap();
        let path_value =
            std::env::join_paths([&first, &second]).unwrap();

        let located = locate_binary(WHISPER_BINARIES, Some(&path_value)).unwrap();

        assert_eq!(located, second.join(binary_file_name("whisper-cli")));
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn whisper_arguments_match_the_located_cli_flavour() {
        let audio = Path::new("/work/episode.mp3");
        let transcripts = Path::new("/work/.agent/transcripts");

        let cpp = whisper_arguments(
            Path::new("/opt/bin/whisper-cli"),
            audio,
            transcripts,
            "episode",
            Some("en"),
        );
        assert_eq!(
            cpp,
            [
                std::ffi::OsString::from("-f"),
                audio.into(),
                "-otxt".into(),
                "-of".into(),
                transcripts.join("episode").into(),
                "-l".into(),
                "en".into(),
            ]
        );

        let python = whisper_arguments(
            Path::new("/opt/bin/whisper"),
            audio,
            transcripts,
            "episode",
            None,
        );
        assert_eq!(
            python,
            [
                std::ffi::OsString::from(audio),
                "--output_format".into(),
                "txt".into(),
                "--output_dir".into(),
                transcripts.into(),
            ]
        );
    }

    #[test]
    fn validates_youtube_urls_before_shelling_out() {
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=abc123").is_ok());
        assert!(validate_youtube_url("http://youtu.be/abc123").is_ok());
        assert!(validate_youtube_url("https://m.youtube.com/watch?v=abc123").is_ok());
        assert!(validate_youtube_url("youtube.com/watch?v=abc123").is_err());
        assert!(validate_youtube_url("ftp://youtube.com/watch?v=abc123").is_err());
        assert!(validate_youtube_url("https://example.com/watch?v=abc123").is_err());
        // SSRF: the host is parsed, not substring-matched, so a youtube-looking
        // path/query on an internal host must be rejected.
        assert!(validate_youtube_url("https://10.0.0.5:8080/admin?ref=youtu.be/x").is_err());
        assert!(validate_youtube_url("https://evil.com/?u=youtube.com/").is_err());
        assert!(validate_youtube_url("https://youtube.com.evil.com/watch?v=x").is_err());
        assert!(validate_youtube_url("https://localhost/youtu.be/x").is_err());
        assert!(validate_youtube_url("https://youtu.be@127.0.0.1/x").is_err());
    }

    #[test]
    fn parses_youtube_mode_with_a_transcript_default() {
        assert_eq!(
            parse_youtube_mode(&serde_json::json!({})),
            Ok(YoutubeMode::Transcript)
        );
        assert_eq!(
            parse_youtube_mode(&serde_json::json!({"mode": "frames"})),
            Ok(YoutubeMode::Frames)
        );
        assert_eq!(
            parse_youtube_mode(&serde_json::json!({"mode": "captions"})),
            Err("Invalid mode `captions`; expected `transcript` or `frames`".into())
        );
    }

    #[test]
    fn bounds_stderr_tails_in_error_messages() {
        let output = Output {
            status: exit_status(1),
            stdout: Vec::new(),
            stderr: "e".repeat(MAX_STDERR_TAIL_CHARS + 100).into_bytes(),
        };
        let tail = stderr_tail(&output);
        assert!(tail.starts_with("[...] "));
        assert_eq!(tail.chars().count(), MAX_STDERR_TAIL_CHARS + "[...] ".len());

        let empty = Output {
            status: exit_status(1),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        assert_eq!(stderr_tail(&empty), "(no stderr output)");
    }

    #[cfg(unix)]
    fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code << 8)
    }

    #[cfg(windows)]
    fn exit_status(code: i32) -> std::process::ExitStatus {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code as u32)
    }

    #[test]
    fn rejects_non_string_language_and_accepts_missing_language() {
        assert_eq!(
            optional_string(&serde_json::json!({}), "language").unwrap(),
            None
        );
        assert_eq!(
            optional_string(&serde_json::json!({"language": "en"}), "language").unwrap(),
            Some("en".into())
        );
        assert!(optional_string(&serde_json::json!({"language": 5}), "language").is_err());
        assert!(optional_string(&serde_json::json!({"language": ""}), "language").is_err());
    }
}
