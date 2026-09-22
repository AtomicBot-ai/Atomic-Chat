---
date: 2026-09-14
title: "Register the shared HTTP commands on mobile, and make a refused connection say so"
---

# 2026-09-14 — Register the shared HTTP commands on mobile, and make a refused connection say so

- **Context:** Three community reports turned out to be two structural gaps.

  `src-tauri/src/lib.rs` carries **two** `invoke_handler(generate_handler![…])`
  blocks — one under `#[cfg(not(any(target_os = "android", target_os = "ios")))]`,
  one under `#[cfg(any(…))]` — and a command added to one is silently absent from
  the other. `get_local_http` was added to the desktop block in `b11c4657d`, when
  it only served loopback providers; `658a16318` then routed **every** provider's
  model listing through it and deleted the `fetchTauri` fallback. Nothing on
  mobile could list models from that point on
  ([#293](https://github.com/AtomicBot-ai/Atomic-Chat/issues/293)). The
  ipc-contract test did not catch it: its "registers every frontend app command"
  check compares call sites against the **union** of both handlers, and
  `EXPECTED_DESKTOP_ONLY` recorded the split as intentional.

  Separately, a user with a dead proxy in Settings
  ([#290](https://github.com/AtomicBot-ai/Atomic-Chat/issues/290),
  [#289](https://github.com/AtomicBot-ai/Atomic-Chat/issues/289)) saw a download
  card frozen at 0% and a project upload that never finished. The proxy was
  their own misconfiguration; everything about how invisible it was, was ours.
  `validate_proxy_config` only ever checked URL syntax, so nothing in the app
  had talked to the address the user typed.

- **Decision:**

  1. `post_local_http` / `get_local_http` / `stream_local_http` are registered on
     **both** handlers. `core::http` is plain `reqwest` with no `cfg` gate, so it
     already compiled for iOS/Android. A `MOBILE_REQUIRED` set in
     `ipc-contract.test.ts` now asserts per-handler presence for commands shared
     frontend code invokes, instead of trusting the union. `EXPECTED_DESKTOP_ONLY`
     keeps only commands that are genuinely desktop-gated — ChatGPT sign-in
     (`PlatformFeature.CHATGPT_SUBSCRIPTION`), the updater, and the best-effort
     `set_telemetry_*` calls that swallow their own rejections.
  2. Transport failures are classified before the disk heuristics in
     `classifyDownloadFailure`, keyed on reqwest's wording plus WinSock codes
     (10060/10061/10065/11001) rather than on a bare `os error` — which had been
     filing every connection refusal as `disk_io`. `proxy` is a new reason,
     separate from `network`.
  3. The downloader emits a `stage` field on its progress event (`connecting`,
     `retrying` with attempt/max) from both retry ladders. Stage events carry no
     byte counts and are relayed on a separate callback, so a retry can never
     rewind the progress bar.
  4. A new `test_proxy_connection` command sends one real request through the
     configured proxy, behind a **Test connection** button in Settings → HTTPS
     Proxy. We do **not** fall back to a direct connection when the proxy is
     unreachable: silently overriding an explicit user setting would trade a
     visible failure for an invisible one.

- **Consequences:** Adding a Tauri command still means touching two lists, but
  forgetting the mobile one is now a test failure rather than a shipped
  regression. `DownloadEvent` gained an optional field, so every construction
  site in `helpers.rs` names `stage`; consumers must treat a staged event as a
  status change, never as progress. Telemetry gains a `proxy` reason and
  `disk_io` volume should fall — the "disk_io is the largest failure cause"
  premise recorded in `helpers.rs` was inflated by the misclassification, so
  re-read those dashboards before acting on them. The proxy test targets
  `huggingface.co` specifically, so a pass means model downloads work rather
  than that some unrelated host is reachable.

- **Owner:** `team`
- **Links:** [#293](https://github.com/AtomicBot-ai/Atomic-Chat/issues/293),
  [#290](https://github.com/AtomicBot-ai/Atomic-Chat/issues/290),
  [#289](https://github.com/AtomicBot-ai/Atomic-Chat/issues/289);
  `src-tauri/src/lib.rs`, `src-tauri/src/core/downloads/{commands,helpers,models}.rs`,
  `web-app/src/lib/telemetry.ts`, `web-app/src/lib/__tests__/ipc-contract.test.ts`,
  `web-app/src/routes/settings/https-proxy.tsx`, `web-app/src/containers/ProjectFiles.tsx`
