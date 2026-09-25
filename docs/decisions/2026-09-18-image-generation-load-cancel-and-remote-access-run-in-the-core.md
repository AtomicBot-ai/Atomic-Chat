---
date: 2026-09-18
title: "Image generation, load cancellation and Remote & LAN run in the core"
---

# 2026-09-18 — Image generation, load cancellation and Remote & LAN run in the core

- **Context:** v2.0.38–2.0.40 (`feat/image-generation-sdcpp`) added four backends to the app's
  Rust: `tauri-plugin-atomic-diffusion` (one resident `sd-server` per loaded model, jobs, step
  progress, the gallery), `/v1/images/generations` in the app's proxy, `cancel_*_model_load` in the
  three runtime plugins with `utils/load_cancel.rs`, and Remote & LAN (a `cloudflared` quick tunnel
  plus per-request trusted hosts in `dynamic_hosts.rs`). In parallel
  [the core took every desktop runtime and the public API](2026-09-17-the-core-owns-every-desktop-runtime-unconditionally.md):
  the plugins lost their process tables, the app's proxy became mobile-only, and the webview reaches
  the core only through `atomic_core_call`. Every one of the four backends was written on Rust that
  no longer runs on desktop, so merging the frontend line onto the core line left them dead code.
- **Decision:** The frontend of the image-generation line is merged as it is
  (`feat/core-migration-image-generation`, merge commit `4962ef0c6`); the four backends are
  re-implemented in `atomic-chat-core` 0.3.0 (stage 7 there: `src/diffusion/`,
  `src/server/public/{images,dynamic-hosts}.ts`, `src/remote-access/`,
  `src/runtime/shared/load-cancel.ts`, `POST /disk/available`) and the app's Rust copies are
  deleted rather than kept behind a flag. The seam in this repository:
  - `services/diffusion/tauri.ts` maps the twenty plugin commands onto
    `/atomic/v1/diffusion/*` through `atomic_core_call`, with the core's JSON exactly the plugin's
    camelCase and its 21 error codes verbatim, so the error routing in `lib/diffusion/errors.ts`
    and the stores' handling of the plugin's answers did not change. A core rejection outside
    those 21 codes (`CORE_UNREACHABLE`, `CORE_VERSION_MISMATCH`, `INVALID_ARGUMENT`, `HTTP_<status>`)
    keeps its message and carries its code in `details` under the INTERNAL route. The four plugin
    events arrive as `atomic-core://diffusion:{state,progress,job,error}`.
  - The core holds the diffusion configuration in memory only, and each `PUT /diffusion/config`
    replaces all of it (the plugin behaved the same way, so a chosen output folder never survived
    an app restart). The app now keeps the output folder in its persisted image settings
    (`useImageSetting.outputDir`; picking the default folder stores none, so it follows the data
    folder) and sends it with the idle interval on every configure: on bind, on a settings change,
    and on every `atomic-core://snapshot`, which the relay emits on each attachment, a reattach to
    the same core included. A stored folder the core cannot create (an unplugged drive) makes that
    configure fall back to the default folder, keeping the choice for next time.
  - `services/diffusion/install.ts` asks the core for free disk space
    (`POST /disk/available`, inside the data folder only) instead of the deleted
    `available_disk_space`; downloads and decompression stay in the app.
  - `services/app/tauri.ts` maps the Remote & LAN commands onto `GET /remote-access`,
    `POST /remote-access/{start,stop}` and `GET /lan-addresses`; a refused start keeps the core's
    `details` so `parseRemoteAccessRejection` reads the same reasons; any other core failure is
    reported by its code (`core_unreachable`), never by its text. A status read that fails because
    the core is down no longer marks the feature unavailable: the card keeps its last state, drops
    a live one once the server is known to be stopped, and reads again on the next
    `atomic-core://snapshot`. The status event is `atomic-core://remote-access:status`.
    `launch.rs` passes the bundled sidecar to the core as `--cloudflared-bin` (a Tauri
    `externalBin`, next to the app executable) — packaging, signing and the release steps are
    unchanged. The tunnel 2.0.40 journalled at `<data>/remote-access-tunnel.json` and reaped at its
    own startup is now reaped once by the core, with the same identity and name checks (core ADR
    `2026-09-18-reap-the-tunnel-atomic-chat-2-0-40-journalled-at-the-data-root.md`); this record
    is that path's counterpart on the app side.
  - The runtime extensions share `extensions/shared/loadCancel.ts`: `cancelLoad` is
    `POST /models/:provider/:id/load/cancel`, retried every 50 ms while the load request is still
    on its way to the core (counted per model, so overlapping loads of one model all stay
    reachable), and a session that came up before the cancel landed is unloaded again.
    The load rejects with an `Error` carrying `code: 'MODEL_LOAD_CANCELLED'`, which the web app
    treats as the user's choice. The `installingEngine` and `loadingWeights` stages stay in the
    extensions (the page-cache probe is a Rust command; the core is runtime-agnostic), and so do
    the engine-update offers.
  - `relay.rs` emits the core's `download:stage` under the legacy `download-<taskId>` name with
    zeroed counters. The core downloads for the app only when it installs a llama.cpp backend, and
    the two llama extensions' install listeners turn a frame with `stage` into a status update of
    the backend's download row ("Retrying 2/5"), never into progress. `client.rs` gives
    `POST /diffusion/model/load` no client-side deadline: the core's own startup budget (600 s by
    default) starts only after it has cancelled a running job, torn the old session down and
    checked the files, so an equal client deadline would fire first and hide the core's error.
    `api_request_analytics.rs` accepts the `images/generations`
    endpoint, the `atomic-diffusion` backend and the `busy`/`timeout`/`upstream` error kinds the
    core's image route reports.
  - `process_reaper.rs` keeps `sd-server` in its prefix list: orphans of 2.0.38–2.0.40 are still
    reaped, and a live core's children are spared through its process journal as before.
- **Consequences:** `tests/desktop-legacy-path.test.mjs` fails when webview sources name the
  `plugin:atomic-diffusion` prefix or an `atomic-diffusion://` event (the form the plugin's seam
  used), on the removed commands (`get_remote_access_status`, `start_remote_access`,
  `stop_remote_access`, `get_lan_addresses`, `available_disk_space`, `cancel_*_model_load`), on
  the moved Rust modules in `src-tauri/src`, and on load-cancel code in the utils crate or a
  runtime plugin. `package.json` pins `atomicCore.version` to `0.3.0`; CI's `download:core` works
  only once that release is published. `sd.cpp` engines and models are still downloaded by the
  app and finalized by the core (`POST /diffusion/backends/finalize`), so a headless install stays
  out of scope. Windows and Linux were not run locally: the tunnel and `sd-server` paths there
  rest on the core's CI. The app's own proxy on mobile does not serve `/v1/images/generations`.
  Two limits carried over, not introduced: a tunnel lost with a crashed core is not restarted
  unless auto-start is on (a quick tunnel would come back under a new URL anyway), and a full
  app exit waits for an in-flight model load, image or chat, before it shuts the core down.
- **Owner:** team.
- **Links:** core plan `../../../atomic-chat-core/PLAN.md` (stage 7) and its ADRs
  `2026-09-17-image-generation-is-its-own-module-not-a-local-runtime.md`,
  `2026-09-17-cancel-a-model-load-through-a-shared-registry.md`,
  `2026-09-17-the-core-owns-the-cloudflare-quick-tunnel.md`,
  `2026-09-18-serve-images-generations-locally-from-the-job-runner.md`;
  [data layout kept](2026-09-18-keep-the-image-generation-data-layout-the-core-now-owns.md);
  [webview reaches the core only through Rust](2026-09-16-the-webview-reaches-the-core-only-through-rust.md).

<!--
Supersedes: 2026-09-10-generate-images-locally-with-stable-diffusion-cpp-in-its-own-plugin.md (the
plugin half: the engine, jobs and gallery now run in the core; the web-app half stands),
2026-09-10-serve-openai-images-generations-from-the-local-api-server.md (the route moved to the
core's public server, same envelope and limits), and the Rust half of
2026-09-17-expose-the-local-api-server-through-a-cloudflare-tunnel-and-on-the-lan.md and
2026-09-15-say-what-a-model-load-is-waiting-on-and-let-it-be-cancelled.md (the UI decisions stand).
-->
