---
date: 2026-09-24
title: "Integrate inference runtimes behind one Rust adapter layer, starting with a catalog and a read-only scan"
---

# 2026-09-24 — Integrate inference runtimes behind one Rust adapter layer, starting with a catalog and a read-only scan

- **Context:** The 2026-09-24 inference runtime catalog lists 63 runtimes (llama.cpp,
  Ollama, LM Studio, vLLM, ComfyUI, whisper.cpp, Piper and so on) that Radium could run
  or monitor on the target workstation, Windows 11 with two RTX 3090s. Radium already
  serves three backends behind `localhost:1337/v1`, and it runs one managed child of its
  own, the stable-diffusion.cpp media engine (PR #23). There was no shared place for:
  - what a runtime is and how Radium should integrate it;
  - which GPU it goes on;
  - which port it gets;
  - where its telemetry comes from.

  Helix needs every one of those per running engine. It also needs each request's
  tokens counted once, even when the request passes through a wrapper such as TabbyAPI,
  LocalAI or Dynamo on its way to the engine.

- **Decision:** add `src-tauri/src/core/runtimes/`, a desktop-only Rust module:
  - `descriptor` + `registry`: all 63 runtimes as static data. Each entry records its
    tier (phase), its mode, its layer (engine, wrapper or library), licence class,
    maintenance status, and whether it was verified. The mode is one of: bundled,
    managed-install, attach, in-process, WSL-hosted, or out-of-scope with a reason.
    Tests enforce the policy:
    - copyleft and closed-source runtimes are never bundled or linked;
    - Linux-only runtimes are WSL-hosted, attached or out of scope on Windows;
    - archived or maintenance-mode projects are never scheduled.
  - `gpu`: a VRAM ledger keyed by GPU UUID. Placement profiles are Auto,
    Pinned, SplitLayer and SplitTensor. Two 24 GB cards are never treated as one 48 GB
    card. Headroom is 768 MiB per card.
  - `ports`: a lease broker for managed children on `127.0.0.1:39000-39999`. The
    range stays clear of 1337, of chat's 3000-3999, and of every catalog default port.
  - `telemetry`: a Prometheus text parser; per-engine counter maps (llama.cpp, vLLM,
    SGLang, TGI); per-request timing readers (Ollama nanoseconds, llama.cpp `timings`,
    OpenAI `usage`). Attribution counts a request's tokens once, at the deepest layer
    that reported them, and charges them to the engine. SGLang per-rank series count
    from `tp_rank=0` only.
  - `probe` + `commands`: `runtimes_catalog` and `runtimes_detect`.
    - Detection asks each catalog default port on 127.0.0.1, plus any addresses the
      user adds. It identifies servers by responses only one runtime gives:
      - KoboldCpp `/api/extra/version`, checked first because it emulates the
        OpenAI, Ollama and A1111 APIs;
      - Ollama `/api/version` + `/api/tags`;
      - ComfyUI `/system_stats`;
      - llama.cpp `/props`;
      - SGLang `/get_model_info`;
      - TGI `/info`;
      - InvokeAI `/api/v1/app/version`;
      - A1111 `/sdapi/v1/sd-models`;
      - the vLLM or Aphrodite metric namespace.
    - A server that only answers the generic `/v1/models` is reported as a port
      guess, with every candidate listed. It is never presented as a confirmed
      identity.
    - Detection is GET-only and changes nothing.
    - Radium's own port 1337 is not scanned. Jan's default port is also 1337, and
      Jan does not fall back to another port.
  - Settings > Runtimes (desktop only) shows the scan and the catalog, filterable by
    phase and searchable.

  Starting, installing and supervising runtimes comes later, as adapters on top of this
  layer. `media::supervisor` stays the pattern for a managed child: pinned download, a
  private loopback port, ready polling and kill-on-drop.

- **Consequences:**
  - Every later adapter gets placement, a port and telemetry from one place.
  - The catalog is data, so re-verifying a runtime is a one-line edit with a test
    guarding the policy.
  - Detection gives Helix a live list of the engines on this computer without
    Radium owning them.
  - Cost: 63 descriptors to keep current. Entries marked `verified: false` carry the
    catalog's description only, and must be re-checked before an adapter is built
    for them.
  - Watch for:
    - an A1111 hit may be Forge, and a `/props` hit may be llama-cpp-python; both are
      listed as alternatives;
    - metric names change between engine releases, so pin a version per adapter and
      update `telemetry::metric_map` with it;
    - `/metrics` is off by default for llama.cpp (`--metrics`) and SGLang
      (`--enable-metrics`), so `counters` is `null` until it is turned on;
    - a scan asks about 25 loopback ports, and closed ports cost one refused connect
      each (250 ms timeout).
  - No new dependencies: reqwest comes through `tauri-plugin-http`, which the media
    engine already uses.

- **Owner:** @walladanger

- **Links:**
  - `src-tauri/src/core/runtimes/`
  - `web-app/src/routes/settings/runtimes.tsx`
  - `web-app/src/services/runtimes.ts`
  - the runtime integration plan (Phases 0-5) and the 2026-09-24 inference runtime
    catalog
  - [llama.cpp multi-GPU](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md)
  - [Ollama API](https://docs.ollama.com/)
  - [SGLang production metrics](https://docs.sglang.io/references/production_metrics.html)
