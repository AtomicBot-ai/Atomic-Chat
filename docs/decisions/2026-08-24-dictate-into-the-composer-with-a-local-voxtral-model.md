---
date: 2026-08-24
title: "Dictate into the composer with a local Voxtral model on llamacpp-upstream"
---

# 2026-08-24 — Dictate into the composer with a local Voxtral model on `llamacpp-upstream`

- **Context:** The composer had no voice input. Nothing existed to build on:
  `getUserMedia`, `MediaRecorder`, `new Worker`, WASM and ONNX have zero
  occurrences in `web-app/src`, `core/src` and `extensions/*/src`, and
  `src-tauri` carried no audio crate. The only speech feature in the product was
  the `audio-transcribe` agent skill, which shells out to a `whisper` CLI the
  user has to `brew install` themselves.

  The obvious build — compile `whisper.cpp` in via `whisper-rs` — turned out to
  be the expensive one. It adds cmake, a C++ toolchain and libclang to a
  933-crate `Cargo.lock` that has none of them; it compiles twice per macOS
  release under `lto = "fat"` + `codegen-units = 1`; whisper.cpp publishes no
  macOS binaries (only an xcframework), so a sidecar variant would mean standing
  up our own build-and-sign pipeline for three platforms; and it would run
  *in-process*, inheriting the app's hardened runtime rather than sidestepping it
  the way a spawned `llama-server` does.

  Meanwhile the engine was already in the bundle and already signed. The
  upstream `libmtmd` we ship (`b10431`) carries the `voxtral` audio projector
  alongside `qwen3a`, `qwen2a`, `gemma4a`, `granite_speech` and `parakeet`, and
  the bundled `llama-server` already serves `/v1/audio/transcriptions` — the
  handler symbol `convert_transcriptions_to_chatcmpl(...)` and its literals
  (`No input file found for transcription`, `Only 'json' response_format is
  supported for transcription`, `The current model does not support audio
  input.`) are all present in the shipped binary. None of it was reachable from
  the app: the extension never mentioned audio, and every mmproj was
  unconditionally tagged `vision`.

- **Decision:** Transcribe on the existing `llamacpp-upstream` engine with one
  model, `ggml-org/Voxtral-Mini-3B-2507-GGUF` (Q4_K_M + Q8_0 mmproj,
  3,188,716,000 bytes ≈ 2.97 GB), downloaded through the ordinary
  `pullModelWithMetadata` pipeline. Capture audio natively in a new
  `tauri-plugin-atomic-audio` built on `cpal`, segment it with an energy VAD, and
  POST each finished phrase to `/v1/audio/transcriptions` from Rust.

  Marginal installer cost: **0 bytes**. Marginal signing and notarisation work:
  **none**. The only CI change is `libasound2-dev` + `pkg-config` on the Linux
  job, for ALSA.

- **Consequences:**
  - **Capture is native, not `getUserMedia`.** That gives raw 16 kHz mono PCM
    with no resampling in JavaScript, works on Linux where WebKitGTK's media
    capture is unreliable, and keeps audio off the IPC bridge — Tauri v2
    serialises `Vec<u8>` as a JSON array of numbers, so a four-second segment
    would cross as roughly half a megabyte of JSON several times a minute.
  - **`cpal` is the one new dependency, and it is pure Rust on every target we
    ship.** As of `coreaudio-rs` 0.14.2 the macOS path resolves to
    `objc2-core-audio`; `cargo tree -i bindgen` and `cargo tree -i coreaudio-sys`
    both come back empty. Windows uses the `windows` crate. Linux links ALSA via
    `alsa-sys`, which needs `libasound2-dev` and `pkg-config` at build time and
    `libasound.so.2` at runtime. That `.so` is deliberately **not** bundled — it
    is on the AppImage excludelist, bundling it breaks ALSA's plugin loader, and
    it arrives on any machine that can run the app through
    `libwebkit2gtk` → `gstreamer1.0-plugins-base` → `libgstaudio`.
  - **Transcription is phrase-level, not word-level.** `libmtmd` processes audio
    in fixed 30 s windows and llama.cpp has no realtime ASR — the planning issue
    for it (ggml-org/llama.cpp#20914) is closed as not planned. So the VAD cuts
    the stream at natural pauses and each finished phrase is transcribed and
    appended while the user keeps talking. Segments are capped at 15 s to bound
    latency and stay inside one `libmtmd` window; a 300 ms pre-roll keeps the
    first phoneme, and a force-close carries its tail into the next segment so a
    word split across the boundary survives.
  - **Only finalized phrases enter the prompt.** A partial rewriting itself
    several times a second would re-render the 2900-line composer at that rate
    and fight `TextareaAutosize`, and a plain `<textarea>` cannot style a
    substring — provisional text inside the box would be indistinguishable from
    committed text. The in-flight phrase renders in the recording bar instead.
  - **The voice model runs alongside the chat model.** It loads with
    `bypassAutoUnload`, and `performLoad`'s auto-unload now excludes it by id —
    without that second half, the next chat-model load would kill dictation
    mid-sentence. It unloads itself after 5 minutes idle. On memory-constrained
    machines this is ~3.4–3.6 GB resident on top of whatever is already loaded;
    `settings:voice.unloadChatModel` lets a user opt into eviction instead.
  - **An mmproj is no longer assumed to be a vision projector.** `list()` now
    reads `clip.has_audio_encoder` / `clip.audio.projector_type` via
    `classifyProjector()` and caches the verdict in `model.yml` next to
    `embedding`. Metadata it cannot classify still falls back to `vision`, so no
    existing model loses a capability. `general.architecture` is `clip` for every
    projector, vision and audio alike, so the arch tells you nothing.
  - **The text-only multimodal fallback is disabled for this model.** For a
    vision model, retrying without `--mmproj` degrades gracefully; for Voxtral it
    would produce a server that starts cleanly and can never transcribe.
  - **Two consecutive failures on distinct segments stop the session** and report
    the llama.cpp build id from `/props`. That is the detection surface for
    transcription regressions like ggml-org/llama.cpp#23688, where a
    healthy-looking server 500s on every segment.
  - **macOS needs both plist entries.** `NSMicrophoneUsageDescription` is
    mandatory — without it macOS terminates the process on first CoreAudio
    access. Permission is read through `AVCaptureDevice`, not by probing: a
    denied microphone makes CoreAudio deliver *silence*, not an error, so
    "recording produced nothing" cannot distinguish refusal from a quiet room.
  - **Not done, deliberately:** audio input to *chat* models
    (`custom-chat-transport.ts` / `model-factory.ts` still gate `input_audio` on
    MLX), SSE streaming transcription, and a lighter model tier. The last one is
    cheap to add later if Voxtral proves too slow — `services/voice` is a seam
    and `transcriptionRegistry.ts` is data, so a second model would not touch the
    UI. `ggml-org/Qwen3-ASR-0.6B-GGUF` (~972 MB) is supported by the same
    `libmtmd` and is the obvious candidate.

- **Owner:** `team`.
- **Links:**
  - `src-tauri/plugins/tauri-plugin-atomic-audio/` — capture, DSP, VAD, WAV, transcription
  - `extensions/llamacpp-upstream-extension/src/transcriptionRegistry.ts`
  - `extensions/llamacpp-upstream-extension/src/index.ts` — `ensureTranscriptionModel`, auto-unload exclusion, projector classification
  - `web-app/src/hooks/useVoiceInput.ts`, `web-app/src/lib/voice/promptMerge.ts`
  - `web-app/src/containers/VoiceInputToggle.tsx`, `web-app/src/containers/dialogs/VoiceSetupDialog.tsx`
  - [llama.cpp realtime ASR planning issue (closed, not planned)](https://github.com/ggml-org/llama.cpp/issues/20914)
