---
date: 2026-09-16
title: "Automate acceptance with layered Tauri evidence"
---

# 2026-09-16 — Automate acceptance with layered Tauri evidence

- **Context:** Atomic Chat has broad Vitest, Rust, IPC, artifact, and optional
  live-contract coverage, but the default gates do not launch the desktop UI.
  The two manual checklists contain more than two hundred checks, while
  `autoqa/` currently has one computer-use scenario, relies on an external UI
  model, still carries Jan-era launch assumptions, and is not part of
  `make verify` or `make test-all`. A UI agent can help explore the product,
  but its interpretation of pixels and free-form success response is not a
  reproducible release assertion.
- **Decision:** Automate acceptance as a layered evidence system. Put each
  repeatable acceptance case at the lowest layer that crosses its
  load-bearing boundary and asserts the user-visible or externally observable
  outcome: Vitest with official Tauri mocks for frontend behavior and IPC
  shapes; Rust and process/socket contracts for backend behavior; WebdriverIO
  with the Tauri service for a small cross-platform set of packaged desktop
  journeys; and provisioned platform jobs for installers, migrations, OS
  integration, and real backend/model acceptance. Keep computer-use automation
  outside mandatory gates as an exploratory source of new deterministic test
  cases.
- **Consequences:** The manual checklist becomes a case catalog whose entries
  identify their owner layer, platforms, fixture, automated test, evidence
  grade, and any documented reason for remaining manual. Pull requests can
  run deterministic browser/contract coverage without model downloads, while
  desktop and platform suites prove the boundaries those tests replace. This
  requires a test-only Tauri build feature, isolated data and home directories,
  configurable test ports, deterministic local backend fixtures, and failure
  artifacts. Native desktop tests remain sequential because Atomic Chat is
  single-instance and normally owns port 1337. The approach adds CI and fixture
  maintenance, but avoids making every branch depend on slow native UI flows.
- **Owner:** team
- **Links:** [`docs/e2e-automation-plan.md`](../e2e-automation-plan.md),
  [`docs/testing-critical-flows.md`](../testing-critical-flows.md),
  [`tests/checklist.md`](../../tests/checklist.md),
  [`autoqa/README.md`](../../autoqa/README.md),
  [Tauri WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/),
  [Tauri API mocks](https://v2.tauri.app/develop/tests/mocking/)

## Evidence layers

### 1. Frontend behavior and Tauri adapter contracts

Use production React components, stores, hooks, and service adapters. Vitest
continues to use `@tauri-apps/api/mocks`; browser journeys may use the Tauri
service's browser mode when a multi-page user flow is clearer than a component
test. These tests may replace Rust and external services, but must assert the
rendered or persisted result in addition to the outbound call.

This layer owns navigation, forms, validation, loading and failure states,
accessibility, deterministic streaming presentation, and frontend persistence
rules. It does not prove a packaged WebView, Rust command registration, a
sidecar process, or an OS integration.

### 2. Rust, IPC, process, and socket contracts

Use the existing Tauri test facade, temporary workspaces, scripted loopback
servers, and real child processes where the process boundary is the behavior
under test. This layer owns command routing and serialization, storage and
migration invariants, server protocol behavior, sidecar lifecycle, cleanup,
and failure recovery.

For the local OpenAI-compatible API, a strong deterministic test opens a real
socket and exercises the production route against a scripted local backend.
For model-dependent behavior, protocol and lifecycle tests use fixtures; real
weights belong to separately provisioned acceptance.

### 3. Packaged desktop journeys

Use WebdriverIO with `@wdio/tauri-service`. The default provider is the
embedded driver so the same harness can run on macOS, Windows, and Linux. Tauri
WebDriver plugins are optional Rust dependencies registered only by a dedicated
`e2e` feature and are never present in release builds.

Desktop journeys prove only boundaries that lower layers cannot prove:

1. clean onboarding completes and survives restart;
2. a deterministic fixture backend reaches model-ready state and produces one
   streamed, persisted reply;
3. a thread rehydrates after desktop restart;
4. the UI starts the local API and an external client completes authenticated
   and streamed requests;
5. one Launch integration writes idempotent configuration in an isolated home;
6. data-folder relocation preserves authority on success and rollback.

The living acceptance contract and evidence grades remain in
`docs/testing-critical-flows.md`. New desktop journeys need a stated boundary;
they must not duplicate branch coverage already proved below the UI.

### 4. Provisioned platform acceptance

Use clean platform runners or VM snapshots for behavior that depends on an
installer, updater, OS permission, desktop integration, hardware tier, or a
production backend binary. These jobs own install/update/uninstall, legacy data
migration, file dialogs, tray, deep links, autostart, GPU/backend selection,
and a minimal real-model response.

Provisioned tests are scheduled according to cost: release-critical migration
and installer checks block a release; expensive hardware and model matrices run
nightly or on explicit compatibility changes. They record the exact OS,
hardware, backend tag, model fixture, and artifact hashes.

## Test isolation and determinism

- Every run gets a temporary application-data directory and home directory.
  Tests never read or write an operator's Atomic Chat profile.
- Desktop runs use a reserved or dynamically assigned test API port and expose
  the resolved value to the external test client.
- Native desktop runs set one worker. Tests restart the process deliberately
  instead of launching concurrent instances.
- Pull-request suites do not contact public model registries, cloud providers,
  telemetry, update services, or model download hosts. Fixtures provide every
  required response.
- Fixture backends support ordered streaming, cancellation, tool calls,
  authentication failure, process failure, and controlled readiness delay.
- On failure, the harness keeps a screenshot, frontend console, Rust log,
  backend log, resolved test paths and ports, and WDIO report. Video is kept
  only where it materially helps diagnose platform interaction.

## Acceptance catalog

`tests/checklist.md` remains the source inventory until its entries are moved
into a machine-readable catalog. Each repeatable case receives a stable id and
records:

- user outcome and priority;
- owner layer and platforms;
- required fixture or provisioned artifact;
- automated test path and evidence grade;
- execution tier: pull request, platform smoke, nightly, or release;
- reason and review date when it remains manual.

Progress is measured by acceptance cases with evidence, not by test count or
line coverage. A case is automated only when its production entrypoint and
observable outcome are both exercised at the declared layer.

## Alternatives rejected

- **Use Playwright directly against every native WebView.** Playwright can
  attach to WebView2 on Windows through CDP, but that does not provide one
  supported harness for macOS WKWebView and Linux WebKitGTK. It remains useful
  for browser-only tests if a future need outweighs introducing a second UI
  runner.
- **Move the entire checklist into native UI tests.** This duplicates lower
  layer coverage, increases build and execution time, and makes failures depend
  on window timing even when the product boundary is a pure storage or
  protocol contract.
- **Promote `autoqa` to the release gate.** A vision agent is useful for
  exploration, but pixel interpretation, free-form planning, and self-reported
  success do not provide stable assertions. Findings should become explicit
  deterministic tests before they block a release.
- **Test only the browser frontend.** Browser tests cannot prove packaged IPC,
  sidecar lifecycle, desktop restart, installer migration, or OS integration.

