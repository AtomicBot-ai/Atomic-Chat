# Integration regression fixes — 2026-10-28

Branch: `change/qa-2-2-25-and-support-chat`.

This records the fixes and follow-up verification for the [original regression report](2026-10-28-integration-regression.md). The original report and its evidence remain unchanged.

## Findings addressed

| Finding | Change | Verification |
| --- | --- | --- |
| INT-01 | Hermes selects `custom:atomic-chat` and stores the current API key in that named provider. | Installed Hermes returned replies with the initial key, a rotated key, and authentication disabled. Rust tests cover escaping and preservation of unrelated providers. |
| INT-02 | OpenClaude receives the key in both its provider profile and startup environment. | Installed OpenClaude returned replies after setup, key rotation, and key removal. Both configuration paths and unrelated profiles are checked. |
| INT-03 | Zed receives the current key. Its CLI uses `--foreground`; the macOS fallback invokes the native executable. A running editor must be quit before reconnecting. | Real configure/launch IPC to an inert Zed executable captured each key. Rust tests cover both launch paths and the running-editor refusal. |
| INT-04 | Shared shell escaping protects keys, models, URLs and executable paths. Windows uses a literal PowerShell script encoded across the `cmd.exe` boundary. | POSIX tests execute commands with spaces, apostrophes, dollar signs and backticks and check the literal output. Windows tests decode and inspect the UTF-16LE payload. |
| FLOW-01 | Cancel keeps the snackbar visible until cancellation settles. Cancellation remains effective after engine readiness, during API startup and final model-state synchronization. | A regression test reproduced the late-cancel race before the fix. Desktop tests verify removal of the process, session and journal entry, followed by successful reload, with both a deliberately unready fixture and real llama.cpp b11804 / Qwen3.5-9B IQ4_XS. |
| SUP-01 | Conversation creation and message sending have separate 30-second abortable deadlines. Timed-out writes release the queue; retry preserves `client_id`. | Blackholed creation/send, late responses, retry/poll deduplication, network failure and rehydration tests pass. Aborted writes never fall back to a second transport, including aborts reported as `TypeError`. No requests were sent to the support team. |
| UI-01 | Agent cards say Configured and retain Connect. Launch history is cleared when the server leaves Running. | Component tests cover launch history, client exit without a liveness signal, server restart and app-state reset. |
| UI-02 | Install and cloud-provider buttons wrap and stay inside the available width. | Real Chromium measurements cover the 340 px form column, default/XL fonts, light/dark themes, progress and error states. The observed 7 px overflow came from the cloud-provider link; both controls are constrained. |

## Test infrastructure

- Scoped integration actions to their existing card IDs, waited for the fixture backend version, and selected the intended provider explicitly.
- Seeded completed onboarding only for ordinary scenarios; first-run tests override it explicitly.
- Allowed the shipped upstream backend alongside the fixture while continuing to check which process actually serves requests.
- Fixed Remote access selectors, selected its model before starting, included `/v1` in the displayed URL, and reacquired the dialog after reopening it.
- Canonicalized the app executable path and included app output in startup failures. Teardown gives short-lived `--version` probes a bounded grace period while retaining process-leak failures.
- Made the cancellation fixture unready through both its health endpoint and readiness log. A delayed log alone does not guarantee a pending load.
- Completed the router mocks used by server setup and onboarding layout tests. Layout files run sequentially and clear shared browser storage, preventing persisted language/download/setup state from contaminating another file.

## Verification scope

| Check | Result |
| --- | --- |
| `make verify` | Pass: 7,473 app/core tests, 211 TurboQuant extension tests, 314 upstream extension tests, 1,512 Rust tests. Existing skips/ignores remain. Lint, typecheck, hardening and critical coverage gates pass. |
| `cargo check` / `cargo clippy` | Pass with existing warnings; `--no-default-features --features test-tauri`. The default-feature E2E build also passes. |
| Affected desktop scenarios | 26 pass across the final affected-file runs; 1 optional LAN test skipped. |
| `make test-layout` | Pass: 700 tests in 60 files, Chromium. |

Bounded output: [verify](2026-10-28-fixes-evidence/verify.txt), [Rust checks](2026-10-28-fixes-evidence/rust-checks.txt), [desktop scenarios](2026-10-28-fixes-evidence/desktop.txt), [layout](2026-10-28-fixes-evidence/layout.txt).

A preceding full layout run hit a one-pixel `MessageItem` scroll-anchor failure (699/700 passed). The unchanged assertion and the entire suite passed on rerun without concurrent build/test load; this remains a flake observation, not a changed tolerance.

The desktop app was built from the changed sources in the existing disposable QA checkout, with isolated profiles and the pinned app core. The developer's normal app data and `.env` files were not changed. The real-model test references the existing GGUF and copies the backend into its isolated profile.

Installed-client requests used a local scripted HTTP server. Zed and Poolside are not installed on this host, and native Windows execution was not available. Zed's real editor behavior and Windows native argument handling therefore remain platform validation items. The optional LAN exposure scenario was skipped. These results do not constitute a fresh sign-off of every client in the original integration matrix.

Design details: [external-agent credentials](../decisions/2026-10-28-propagate-current-credentials-to-external-agents.md), [support write deadlines](../decisions/2026-10-28-bound-support-writes-and-preserve-retry-identity.md).
