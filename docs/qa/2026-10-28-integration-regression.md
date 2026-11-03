# Integration and recovery regression — 2026-10-28

**Branch:** `change/qa-2-2-25-and-support-chat`  
**Commit:** `830678456a0ca2c027a5690eb015a1fbdb6059f2` (`release: v2.2.27`)  
**Platform:** macOS 26.5.2 (25F84), Apple Silicon  
**Core:** bundled 0.19.3  
**Recommendation:** fix the authenticated-client failures and the recovery defects below before signing off this branch.

The automated baseline is mostly green, but it does not establish that every configured client can actually talk to the server. Hermes and OpenClaude return configuration success while making unauthenticated requests. Zed receives a placeholder key. Cancellation of an in-progress model load and a stalled support-message request also fail recovery checks.

This is a regression report, not a product patch. No product source changes or commits were made. Diagnostic tests and harness adjustments ran in an isolated copy of this exact commit. The evidence attachments preserve those adjustments separately.

## Coverage and limits

All **23 catalog entries** are accounted for in the matrix below. All **20 automatic configuration commands** were invoked four times: initial setup, identical repeat, changed model/key, and key removal (**80 successful IPC calls**). This checks command execution; it is not proof of end-to-end authentication, configuration consumption, or live model switching in each external application.

Actual installed CLI clients were exercised in isolated homes and empty workspaces. Seven clients returned an answer: Codex, Claude Code, Copilot, Droid, Muse, OpenClaw, and OpenCode. The first six used a scripted inference reply; OpenCode passed against the real Qwen model. Hermes and OpenClaude failed authentication. OpenCode passed the final direct real-inference check; earlier scripted/proxy failures were excluded from product findings. Zed launch environment was captured with an inert executable because the actual editor is not installed.

Most desktop fault scenarios use the **real app and real core with a scripted inference backend**, allowing deterministic disconnects, delayed loads, crashes, and context errors. A separate test successfully loaded **real llama.cpp b11804 and Qwen3.5-9B IQ4_XS**, produced a response, and verified that the same response was displayed and stored. Do not interpret scripted-backend recovery as GPU/driver coverage.

Not covered end to end: Windows/Linux/mobile, real TurboQuant/MLX/TensorRT inference, missing external clients/editors, paid cloud providers, a live support relay conversation, real WAN packet loss/DNS/TLS failures, or every client × every fault combination. No real support message was sent. The report therefore **does not certify a complete live regression of all 23 integrations**.

## Fix list

| ID | Priority | Finding | Evidence level |
| --- | --- | --- | --- |
| INT-01 | P1 | Hermes drops the configured API key and receives 401 | Installed CLI + HTTP trace |
| INT-02 | P1 | OpenClaude drops the configured API key and retries 401 responses | Installed CLI + HTTP trace |
| INT-03 | P1 | Zed launch always injects `atomic`, ignoring the server key | Real configure/launch IPC + captured child environment |
| FLOW-01 | P2 | Cancel dismisses model-load feedback but leaves the backend loading/running | Desktop E2E, reproduced twice |
| SUP-01 | P2 | A stalled support POST blocks the entire send queue indefinitely | Deterministic store reproduction + source inspection |
| INT-04 | P2 | Apostrophes in the API key break Muse and Poolside launch commands | Generated command + shell syntax validation |
| UI-01 | P2 | Exited agents reappear as Connected after server restart | Component state-transition reproduction |
| UI-02 | P3 | Image setup overflows a 340 px column at XL font size | Real-browser layout, light and dark |

P1 means a supported integration is unusable in the tested configuration. P2 means a recovery or supported-input defect. P3 is a layout defect. These are observed defects on the tested commit; this run did not bisect the commit that introduced each one.

### INT-01 — Hermes ignores API authentication

1. Enable a nonempty key on the local API and load a model.
2. Run `configure_hermes_agent` with the local URL, model, and that key.
3. Start Hermes 0.15.1 from the generated configuration and send a short prompt.

**Actual:** configuration succeeds, but `/v1/chat/completions` has no matching bearer key and returns HTTP 401. Hermes exits with `Invalid or missing authorization token`. Its discovery requests also return 401.

**Expected:** the key selected in Atomic Chat reaches the provider used by Hermes.

**Where:** `src-tauri/src/core/system/commands.rs`, `configure_hermes_agent` around line 1340 discards `api_key`; `upsert_atomic_provider` around line 1648 does not persist it.

**Fix/acceptance:** propagate the key using the client's supported configuration or launch environment. Test keyless mode, a nonempty key, key rotation, and a fresh client process after rotation. Keep credentials out of logs.

Evidence: [HTTP trace](2026-10-28-evidence/client-wire.json), [CLI test run](2026-10-28-evidence/real-clients-checked.txt).

### INT-02 — OpenClaude ignores API authentication

Use the same setup with OpenClaude 0.5.2 and `configure_openclaude`.

**Actual:** `/v1/models` and repeated `/v1/chat/completions` requests return 401. No answer is produced; the bounded test terminates the client. A direct run and a diagnostic proxy run both fail.

**Where:** `src-tauri/src/core/system/commands.rs:3046` explicitly discards `api_key`. The provider profile and `.openclaude-profile.json` contain URL/model but no key. The comment assumes the local server is keyless, which is not always true.

**Fix/acceptance:** write or pass the configured key through OpenClaude's actual Atomic provider path. Verify one successful authenticated answer and recovery after key rotation, rather than asserting only the resulting JSON shape.

Evidence: [HTTP trace](2026-10-28-evidence/client-wire.json), [CLI test run](2026-10-28-evidence/real-clients-checked.txt).

### INT-03 — Zed is launched with the wrong key

1. Configure Zed with server key `qa-client-auth-key`.
2. Invoke `launch_zed` with an inert `zed` executable that records only `ATOMIC_CHAT_API_KEY`.

**Actual:** the child receives `atomic`. This cannot authenticate to a server requiring the selected key. The actual Zed UI was not installed or tested.

**Where:** `src-tauri/src/core/system/commands.rs:3330` ignores the configuration key; `launch_zed` at lines 3437–3464 always sets the placeholder, including the macOS fallback.

**Fix/acceptance:** pass the selected key to launch; use a placeholder only for a keyless server. Test both CLI and native-app launch paths, including an editor process that was already open.

Evidence: [captured-environment assertion](2026-10-28-evidence/real-clients-checked.txt), [probe source](2026-10-28-evidence/qa-real-clients.spec.ts.txt).

### FLOW-01 — Cancel does not stop the model load

1. Load the scripted upstream model with a 20-second readiness delay.
2. Wait until its process exists and the `Starting Model` snackbar is visible.
3. Press the snackbar's **Cancel** action.

**Actual:** the snackbar disappears, but the backend is still alive after the 30-second cancellation deadline. Core logs show `model loaded` at about 20 seconds. This happened in two independent profiles, including after fixture selection was made deterministic. The test cannot reach its subsequent reload assertion.

**Expected:** the pending load is cancelled, the process and session are removed, and a later load can succeed. Merely hiding the snackbar is insufficient.

**Investigate:** `web-app/src/containers/ModelLoadSnackbar.tsx` action handler; `web-app/src/utils/switchModel.ts:566`; `web-app/src/services/models/default.ts:961`; `extensions/shared/loadCancel.ts`. The failed boundary is confirmed; its precise root cause has not been isolated to one of these layers.

**Acceptance:** keep the existing `desktop/model-load-cancel.spec.ts` process/session/journal assertions, verify a new successful load afterward, then repeat against a real engine.

Evidence: [repeat run](2026-10-28-evidence/flows-final.txt), [core and visible-state excerpt](2026-10-28-evidence/model-load-cancel.txt).

### SUP-01 — A blackholed support send blocks later messages

1. Allow support conversation creation to finish.
2. Make the first send remain unresolved, representing a connection that neither responds nor closes.
3. Send a second message and advance the test clock by ten minutes.

**Actual:** both messages remain `pending`; only one send has started. Neither message offers Retry. The serialized delivery queue has no deadline on its current request. The existing rehydration test provides recovery after an app restart, but the open session never recovers on its own.

**Where:** `web-app/src/stores/support-chat-store.ts:318`, POST calls around lines 340 and 348, queue at line 368. A timeout on polling does not bound these writes.

**Fix/acceptance:** give conversation creation and message sending bounded, abortable deadlines; mark failed messages retryable and release the queue. Preserve `client_id` on retry so a delayed server acknowledgement does not create duplicates. Test blackholed creation, blackholed send, explicit network rejection, app restart during send, and reconnection.

Evidence: [deterministic result](2026-10-28-evidence/reproductions.txt), [diagnostic test patch](2026-10-28-evidence/diagnostic-unit-tests.patch). This test does not contact the support team.

### INT-04 — Shell quoting breaks Muse and Poolside

Set the API key to `it's-secret` and generate each launch command.

**Actual:** raw single quotes are inserted inside single-quoted shell values; `zsh -n` rejects both commands with `unmatched '`. The normal Muse flow works with the ordinary synthetic key, so this is a supported-input edge case, not a general Muse connection failure.

**Where:** `web-app/src/lib/integration-agent-run.ts:154` (Muse) and line 174 (Poolside). Model IDs are interpolated similarly.

**Fix/acceptance:** use a shared shell-argument escaping routine for keys, model IDs, and URLs. Cover spaces, apostrophes, dollar signs, and backticks without evaluating them. Windows shell quoting needs its own tests; it was not executed here.

Evidence: [failing command assertions](2026-10-28-evidence/launch-quoting.txt), [diagnostic test patch](2026-10-28-evidence/diagnostic-unit-tests.patch).

### UI-01 — Connected is inferred from a stale launch flag

After an agent has been launched once, close the external client, stop the server, and start the server again.

**Actual:** the component returns to **Connected** because `server running && launched[id]` becomes true again. The Connect action is replaced even though no client has reconnected. The state transition was reproduced in a component test; external-process liveness was not instrumented by the app.

**Where:** `web-app/src/containers/server/ServerAgents.tsx:45` and its connected-card action; `useLaunchStore` launch flags.

**Fix/acceptance:** base Connected on observable activity, or label the state as Launched/Configured. Keep an explicit reopen action and invalidate stale launch status across server generations. Verify client exit, server restart, and app restart separately.

Evidence: [diagnostic test patch](2026-10-28-evidence/diagnostic-unit-tests.patch).

### UI-02 — Image setup overflows at XL text size

Render ImageSetupCard in the supported 340 px form column with a 20 px root font, in light and dark themes.

**Actual:** `scrollWidth = 347`, `clientWidth = 340`; two layout cases fail with 7 px horizontal overflow. SupportChatSheet's eight layout cases pass.

**Where:** `web-app/src/containers/images/ImageSetupCard.tsx:138` and the button label grid at lines 154–162.

**Fix/acceptance:** constrain the install button and label to the available column width, preserving readable loading/progress states. Rerun all existing font-size and theme cases.

Evidence: [layout failures](2026-10-28-evidence/layout-failures.txt).

## Integration matrix

`4/4` means successful configure IPC for initial/repeat/model+key change/key removal. It does **not** mean four successful client conversations. Existing Rust fixture tests additionally cover configuration preservation and formats; the matrix records this run's direct observations.

| Integration | Configure IPC | Actual application result / remaining limit |
| --- | --- | --- |
| Atomic Agent | 4/4 | Configuration tested; no real agent turn |
| Hermes Agent | 4/4 | **FAIL**, 0.15.1, authenticated requests return 401 (INT-01) |
| OpenClaw | 4/4 | **PASS**, 2026.6.1, embedded local agent answers; no gateway/channel delivery tested |
| Kilo Code | 4/4 | CLI unavailable; runtime not tested |
| Claude Code | 4/4 | **PASS**, 2.1.303, configured authenticated client answers |
| pi | 4/4 | CLI unavailable; runtime not tested |
| Codex CLI | 4/4 | **PASS**, 0.146.0, actual `atomic-chat` profile answers; UI configure/repeat/migration checks also pass |
| OpenCode | 4/4 | **PASS**, 1.15.13, direct real Qwen inference; scripted/proxy runs are not reliable for this client |
| OpenClaude | 4/4 | **FAIL**, 0.5.2, unauthenticated requests and retries (INT-02) |
| Cline CLI | 4/4 | Inert executable used for configure CLI calls; no real Cline runtime |
| DeepSeek Harness | 4/4 | dsh 0.1.0-rc.7 installed; generated config tested, browser app conversation not tested |
| Zed | 4/4 | **FAIL** key handoff (INT-03); real editor absent |
| ZCode | 4/4 | Desktop configure/repeat/backup/foreign-provider preservation pass; actual editor absent |
| MiMo Code | 4/4 | CLI unavailable; runtime not tested |
| Droid | 4/4 | **PASS**, 0.139.0, configured authenticated client answers |
| Copilot CLI | 4/4 | **PASS**, 1.0.57, uses generated shell environment and answers |
| OpenHands | 4/4 | CLI unavailable; runtime not tested |
| Poolside | 4/4 | **FAIL** quoted-key launch (INT-04); actual client absent |
| Goose | 4/4 | CLI unavailable; runtime not tested |
| Muse Code | 4/4 | **PASS**, 1.0.1, ordinary key + generated endpoint/model flags; **FAIL** quoted-key command (INT-04) |
| VS Code | Manual setup | Editor absent; no live Copilot Chat connection |
| JetBrains | Manual setup | IDE absent; no live AI Assistant connection |
| Xcode | Manual setup | Installed; Coding Intelligence provider setup/conversation not exercised |

## Failure and flow matrix

| Condition | Result | Scope |
| --- | --- | --- |
| Repeat integration configuration | Pass | 20 commands, four invocations each |
| Change configured model and API key; remove key | Commands succeed | Actual use of the new settings by every already-running client remains unverified |
| Local API start/stop + missing/correct bearer key | Pass | Real app/core, scripted backend |
| Client disconnect during SSE generation | Pass | Connection aborted after receiving data; next request completes with `[DONE]` |
| Core killed during active SSE generation | Pass | Interrupted stream does not falsely complete; supervisor restores same address/key; next request succeeds |
| Inference backend killed under a loaded model | Pass | UI reports loss, next message gets a new backend |
| Core killed under a running chat | Pass | New core, no orphaned fake backend, next chat succeeds |
| Switch from local model A to B | Pass | Old process ends, second model answers |
| App/core restart after a saved response | Functional assertions pass | Thread restored; one teardown run reports a bundled-backend process leak, unresolved below |
| App relaunch lifecycle | Pass | Existing `relaunch.spec.ts` |
| Model load failure and Retry | Pass | Error visible, retry available, no fake process/session leak |
| Cancel model while loading | **Fail** | FLOW-01, two reproductions |
| Context overflow, grow/reload, device-fit limit | Pass | All three focused scenarios after fixture readiness fix |
| MCP tool result, deny, Allow Once | Pass | Two scenarios after fixture readiness fix |
| Server setup guide | Pass | Select model, start server, configure client |
| Real local inference | Pass | b11804 + Qwen3.5-9B IQ4_XS; text shown and persisted |
| Support blackholed POST | **Fail** | SUP-01; deterministic ten-minute pending state |
| Support explicit network/server errors, retries, rehydration | Existing tests pass | Mocked relay, not production delivery |
| Support layout | Pass | Eight light/dark/font cases |
| Image setup layout | **Fail** | Two XL cases; six other cases pass |

## Additional investigations

**OpenCode's earlier failures were test-path dependent, not a confirmed product defect.** Direct scripted inference and a buffered diagnostic proxy produced only `step_start`. The final run against real Qwen inference **without the proxy passes**, emitting an assistant text event and exiting 0. The real app/core/selected key/configuration worked. The proxy buffered SSE until completion, so it did not preserve streaming timing; the minimal scripted reply also differs from a real engine response. Do not file the earlier empty output as an Atomic Chat regression. Evidence: [passing direct run](2026-10-28-evidence/opencode-direct.txt), [actual CLI response](2026-10-28-evidence/direct-real-model-opencode.txt).

**One app-restart teardown reports a remaining bundled-backend process.** The local-chat response and persistence assertions pass, but `endSession` reports a process under `llamacpp-upstream/backends/b11463` after core shutdown. The scenario mixes a scripted model with the real bundled backend, and fixture selection also races on relaunch. Keep this as an unresolved cleanup signal; it is not yet sufficient evidence of a leak with a valid real model. Evidence: [final flow log](2026-10-28-evidence/flows-final.txt).

## Automated baseline and test-infrastructure repairs

| Check | Result |
| --- | --- |
| ESLint | 0 errors, 46 warnings |
| TypeScript build check | Pass |
| Telemetry / test-quality guards | Pass; 851 test files inspected |
| Node hardening suite | 109 pass |
| App/core Vitest | 7,463 pass, 19 skipped; 656 passing files, 1 skipped |
| TurboQuant extension Vitest | 211 pass |
| Upstream extension Vitest | 314 pass |
| Critical coverage floors | Pass, 13 files |
| Platform-supported Rust suites | 1,509 pass, 13 ignored; unrestricted rerun |
| Focused broad desktop run | 34 pass, 8 fail before harness corrections; not eight product defects |
| Focused corrected desktop rerun | 13 test bodies pass, 1 fails (cancel); separate local-chat teardown failure |
| Real-model chat | 1 pass |
| OpenCode direct real-model integration | 2 pass (server setup + client answer) |

The initial `make verify` used global Yarn 1 and stopped; Corepack Yarn 4.5.3 was required. The subsequent JavaScript checks passed. Sandbox restrictions caused localhost-binding failures in Rust; the same Rust suites passed when rerun with the required host access. `test-core-live` was blocked by a stale cached Tauri permission path into a deleted worktree. Neither condition is classified as a product defect.

The branch's desktop/layout tests also need maintenance before they can be a dependable release gate:

1. **Integration selectors click the wrong Run button.** A matching agent name in the navigation sidebar makes the ancestor XPath reach the whole page; it can click Atomic Agent's Run instead. Scoping to the existing card IDs (`#codex`, `#zcode`) makes all four launch tests pass. The accidental install happened only inside the isolated test home.
2. **Fixture backend selection races extension initialization.** Wait for the seeded version and select the provider explicitly. Both llama.cpp providers can list the same model; an unqualified count of one is invalid. Corrected context and MCP runs pass.
3. **Seeded profiles do not consistently bypass onboarding.** Add explicit setup-completed state for non-onboarding tests; keep actual first-run cases separate.
4. **Local-chat asserts that only the fake backend exists**, while this build correctly unpacks bundled upstream b11463. Test that the intended backend runs and allow the bundled resource separately.
5. **Remote-access E2E uses an invalid combined selector** (`section[...] button=Start remote access`). This blocks the intended flow before product behavior can be evaluated.
6. **ServerSetupGuide layout mock omits `useRouter`**, so that file fails during module initialization. The full layout run also encountered an unhandled Playwright route-lifecycle rejection; the targeted layout run isolates the ImageSetupCard failures.

All temporary changes are available as a [harness patch](2026-10-28-evidence/temporary-harness-adjustments.patch). They were not applied to the branch's product or test sources. The initial full desktop run was stopped after these blockers; it is not reported as a completed full-suite pass. All QA-owned app, core, and backend processes were confirmed stopped at the end. The original checkout contains only this report and its evidence additions.

## Evidence and repeatability

The persistent [evidence directory](2026-10-28-evidence/) contains [test-result summaries](2026-10-28-evidence/baseline-results.txt), bounded logs, HTTP traces with synthetic credentials represented as booleans, diagnostic test sources, and patches. Full local working data remains at `/tmp/atomic-integration-regression-20261028`; it is temporary and is not the only copy of the findings.

To repeat on a disposable checkout of the commit:

1. Use Corepack Yarn 4.5.3 and run `make verify`; allow the host access required by the Rust and desktop tests.
2. Build the branch's E2E app with its pinned core and current bundled extensions, as described in `tests/e2e` and the Makefile. Do not carry a hand-installed TurboQuant resource into the shipped-resource test.
3. Apply the diagnostic unit-test patch. Its assertions intentionally fail until the reported defects are fixed.
4. Apply the temporary harness patch to the disposable checkout and copy the attached `*.spec.ts.txt` probes into `tests/e2e/desktop` without the `.txt` suffix. Update machine-specific CLI, output, and model paths. The probes depend on the existing E2E harness; they are not standalone programs.
5. Run with `E2E_WORKERS=1`, an existing isolated `TMPDIR`, `ATOMIC_CORE_REPO`, `ATOMIC_CORE_BIN`, and the freshly built `ATOMIC_E2E_APP_BIN`. For real inference also set `ATOMIC_E2E_LLAMA_BACKEND_DIR` and `ATOMIC_E2E_MODEL_GGUF`.
6. Recheck the matrix after the fixes, prioritizing authenticated requests, Cancel cleanup, support deadlines, real client restart, and model/key changes while a client is already running. Complete the absent-client and other-platform rows before claiming full integration sign-off.
