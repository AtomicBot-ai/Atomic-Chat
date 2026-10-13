---
date: 2026-09-25
title: "Run and configure Ollama from Radium: pinned install, env-var settings, take-over"
---

# 2026-09-25 — Run and configure Ollama from Radium: pinned install, env-var settings, take-over

- **Context:** Users switch between runtimes and lose track of which window
  holds which runtime's settings. The ask was for every runtime's settings,
  models and state to live in one Radium panel, in the same controls as the
  llama.cpp settings. Ollama came first. Ollama reads its server configuration
  only from environment variables (`envconfig/config.go`), so its settings can
  only be controlled by whoever starts `ollama serve`.

- **Decision:** Radium can own Ollama.
  - **Install:** on Windows x64, Radium downloads the official standalone
    `ollama-windows-amd64.zip` (the CLI plus its GPU libraries), pinned to
    v0.34.4. It is checked against the SHA-256 on the release's asset list
    (`535193f3…fa62`) and unpacked into `runtimes/ollama/v0.34.4` under the data
    folder, via a staging folder, so a failed unpack leaves nothing half
    installed. Elsewhere, a user-installed Ollama is found (`%LOCALAPPDATA%`,
    PATH, Homebrew paths) and run the same way.
  - **Settings:** stored in `runtimes/ollama/settings.json` and passed as
    Ollama's own variables:
    - `OLLAMA_HOST`, `OLLAMA_MODELS`, `OLLAMA_CONTEXT_LENGTH`,
      `OLLAMA_KEEP_ALIVE`, `OLLAMA_FLASH_ATTENTION`, `OLLAMA_KV_CACHE_TYPE`;
    - `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_SCHED_SPREAD`,
      `OLLAMA_GPU_OVERHEAD`, `OLLAMA_NO_CLOUD`;
    - `CUDA_VISIBLE_DEVICES` by GPU UUID, with `CUDA_DEVICE_ORDER=PCI_BUS_ID`;
    - free-form `KEY=VALUE` lines, applied last.

    Only values that differ from Ollama's defaults are set, so a Windows
    variable the user set still applies. Validation refuses port 1337, a
    relative models folder, a malformed keep-alive and so on, before anything
    is written.
  - **Defaults:** port 11434 and Ollama's own models folder, so existing tools
    and downloaded models keep working.
  - **Process:** started with piped output kept in a 1000-line log buffer, and
    ready once `/api/version` answers. Stopping it also stops its runners:
    `taskkill /T` on Windows, the process group on Unix. It stops when Radium
    quits, and is added to the startup orphan reaper, which only matches
    copies running from the data folder.
  - **Take-over:** when an Ollama Radium did not start answers on the port, the
    panel offers to take it over. With confirmation, Radium stops the tray app
    and server by process name, waits for the port to free, and starts Ollama
    again with Radium's settings, using Radium's copy or else the user's own
    executable.
  - **Models:** listed, downloaded (streamed `/api/pull`, cancellable, with
    progress), deleted, loaded and unloaded through Ollama's documented API.
    This works whether Radium or the user started Ollama.
  - **After start:** Radium's `ollama` provider is connected automatically
    (2026-09-25 connect record), so its models appear in chat.
  - **UI:** one panel on Settings > Runtimes, with collapsible Models, Settings
    and Logs sections. Settings are described as data and drawn with the
    shared `DynamicControllerSetting` controls, with the five everyday settings
    up front and ten under Advanced. Save becomes "Save and restart" when a
    change needs one. The full 63-runtime catalog is folded away until asked
    for.

- **Consequences:**
  - Ollama needs no window or tray app of its own; everything is in one place.
  - The same shape (a settings struct mapped to launch flags or environment,
    a pinned asset, a panel drawn from field data) is the template for
    KoboldCpp, ComfyUI and TabbyAPI.
  - Watch for:
    - the SHA-256 and asset name must be updated together with `VERSION`;
    - the Windows-only stop path (`taskkill /T`) is compiled and exercised only
      by the Windows build and on the target PC, not by the Linux test run;
    - taking over stops the user's tray app. That is what makes Radium's
      settings apply, and the dialog says so.

- **Owner:** @walladanger

- **Links:**
  - `src-tauri/src/core/runtimes/ollama/`
  - `web-app/src/containers/runtimes/OllamaPanel.tsx`
  - `web-app/src/services/ollama.ts`
  - [Ollama envconfig](https://github.com/ollama/ollama/blob/main/envconfig/config.go)
  - [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
  - [v0.34.4 assets](https://github.com/ollama/ollama/releases/tag/v0.34.4)
