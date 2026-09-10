---
date: 2026-07-07
title: "Make llama-server readiness detection version-independent (log-line broadening + `/health` HTTP poll) in both `llamacpp-upstream` and `llamacpp` (turboquant) plugins"
---

# 2026-07-07 — Make llama-server readiness detection version-independent (log-line broadening + `/health` HTTP poll) in both `llamacpp-upstream` and `llamacpp` (turboquant) plugins

- **Context:** Users on recent `llama-server` builds (e.g. macOS on `b9702`+)
  reported the model load hanging indefinitely at "Starting Server", even
  though the attached `app.log` showed `llama-server` itself starting
  successfully and serving requests. Root-caused to upstream
  `ggml-org/llama.cpp` commit `27c8bb4f6` (first released in `b9829`),
  which reworded the server-ready log line — dropping "server is" from
  "server is listening on ..." down to a bare "listening on ...". Both
  `load_llama_model_impl` implementations
  ([`tauri-plugin-llamacpp-upstream/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs)
  and its turboquant twin
  [`tauri-plugin-llamacpp/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs))
  matched stdout/stderr against a small set of exact substrings
  (`"server is listening on"`, `"server listening on"`, `"http server
  listening"`, `"starting the main loop"`, `"all slots are idle"`), so
  neither task's `ready_tx.send(true)` ever fired once upstream changed the
  wording — the `tokio::select!` loop looped silently until the 600s
  `timeout_duration` elapsed. This is a systemic risk: any future upstream
  log rewording (and the `ggml-org/llama.cpp` PR volume is large — dozens
  of merges daily) can silently re-break readiness detection again, with no
  compile-time signal.
- **Decision:** Two complementary, mutually-reinforcing fixes, applied
  identically to **both** plugins (upstream is Windows/Linux/macOS's
  primary provider; turboquant is macOS-only but shares the exact same
  hazard):
  1. **Broaden the log-line matcher.** New private helper
     `is_ready_log_line(line_lower: &str) -> bool` matches the stable
     substring `"listening on"` (present in every historical wording:
     "server is listening on", "server listening on", "router server is
     listening on", and the current bare "listening on"), plus the existing
     `"all slots are idle"` / `"starting the main loop"` / `"http server
     listening"` checks. Both the stdout task and the stderr task now call
     this single helper instead of duplicating an inline substring list —
     one place to extend if upstream reworks phrasing again.
  2. **Add a version-independent `/health` HTTP poll as the primary
     readiness signal.** A new `tokio::spawn`ed `health_task` polls
     `http://127.0.0.1:{port}/health` every 200ms (500ms per-request
     timeout via `reqwest::Client::builder()`, already a dependency in both
     plugins' `Cargo.toml`). Per upstream's own `server-http.cpp` /
     `server-context.cpp` (`middleware_server_state` + `get_health`),
     `/health` is a stable contract across every llama.cpp version we've
     observed: HTTP 503 with a JSON error body while the model is loading,
     HTTP 200 `{"status":"ok"}` once ready — no log-wording dependency at
     all. `ready_tx` is `.clone()`d three ways (`stdout_ready_tx`,
     `stderr_ready_tx`, `health_ready_tx`) so all three tasks can signal
     readiness independently into the same `mpsc` channel without fighting
     over ownership. `health_task.abort()` is called at every loop exit
     point (early-exit-with-error, ready-signal-received, process-exited-
     during-wait, timeout) so the poller never leaks past the function's
     lifetime.
- **Consequences:** Readiness detection now survives future upstream log
  rewording by design — even if every log-based matcher in
  `is_ready_log_line` goes stale again, the `/health` poll independently
  confirms readiness within ~200ms of the server actually being able to
  serve requests, so the previous "hang for 600s then fail" failure mode
  degrades at worst to "detect readiness ~200ms slower than the log line
  would have." Log-based detection is kept (not removed) as a fast,
  zero-latency complement — most loads still resolve on log lines
  microseconds after the process prints them, well before the poll's next
  200ms tick fires. No IPC, settings-schema, or on-disk-layout change;
  scope is confined to the readiness-wait block inside
  `load_llama_model_impl` in both plugins. **Verified:** `cargo check -p
  tauri-plugin-llamacpp-upstream -p tauri-plugin-llamacpp` and `cargo check
  -p Atomic-Chat` both clean (0 errors, only pre-existing dead_code
  warnings); `cargo test` green in both plugins (143 passed in upstream, 124
  in turboquant — no regressions, no new tests added since the change is
  integration-level and requires a live `llama-server` process to exercise
  meaningfully); `ReadLints` clean on both edited files.
- **Owner:** team.
- **Links:** [ggml-org/llama.cpp commit 27c8bb4f6](https://github.com/ggml-org/llama.cpp/commit/27c8bb4f63ad9f20bf5901067810a4be5ffe20c4)
  (the log-wording change that triggered this), `b9829` (first release
  carrying it), §4.2 *LLM backend*, files:
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/commands.rs)
  (`is_ready_log_line`, `load_llama_model_impl` health-check poller),
  [`src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs)
  (mirrored), upstream `tools/server/server-http.cpp`
  (`middleware_server_state`) and `tools/server/server-context.cpp`
  (`get_health`) in `AtomicBot-ai/atomic-llama-cpp-turboquant`.

---
