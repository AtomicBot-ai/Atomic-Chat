# E2E automation rollout plan

## Goal

Replace repeatable manual regression checks with deterministic evidence while
keeping the default developer gate fast, offline, isolated from user data, and
clear about which production boundary each test proves.

The governing decision is
[`2026-09-16 — Automate acceptance with layered Tauri evidence`](decisions/2026-09-16-automate-acceptance-with-layered-tauri-evidence.md).
Evidence strength and the current critical gaps live in
[`testing-critical-flows.md`](testing-critical-flows.md).

## Status (2026-09-18)

The first slice exists on macOS arm64: `make build-app-e2e` and
`make test-app-e2e` run desktop journeys for clean onboarding with restart;
local chat with a fixture backend, persistence and rehydration; the local API
served to an outside client; recovery from a killed backend and a killed core
daemon; switching between two local models; context overflow with and without a window
the app can grow; and a provider setting travelling from the UI to the core and
the backend's argv — with their failure assertions. `make test-app-e2e-live` adds
one opt-in chat against a real `llama-server` and model. A Hub journey downloads
a model from a local fixture catalog, with progress, cancellation, pause and
resume, and a chat afterwards. A conversation journey stops a reply, regenerates,
rewrites and deletes messages, and renames and deletes the thread. A backend
journey installs a release archive from a file and runs the model on it, and
finds, downloads and installs a newer release published locally behind a proxy.
The defects these journeys found were fixed on 2026-09-18; the suite carries no
expected failures. Two more journeys cover the API page's live request log and
the second llama.cpp provider run by the core. A document journey attaches a
file, has the core embed it, and has the model retrieve from it through a tool
call — the scripted backend can now make one. An MCP journey runs a tool from a
stdio server with and without the user's approval, and an agent journey runs the
Rust loop on a local model through a read, a write and a folder-access question.
The Local API is checked across a core crash, the app across its own restart, and
MLX through a scripted `mlx-server`. It narrows the driver choice below — the embedded WebDriver
plugin with the plain `webdriverio` client, without the Tauri service — and
records why in
[Drive the desktop UI through an embedded WebDriver on an isolated profile](decisions/2026-09-18-drive-the-desktop-ui-through-an-embedded-webdriver-on-an-isolated-profile.md).

Against the phases: the phase 1 seams for the data root, home directory and
local API port exist, with the fixture backend taken from `atomic-chat-core`;
the phase 2 harness exists without browser mode; journeys 2 to 6 of phase 3
are implemented and journey 1 in part. Not started: the acceptance catalog
(phase 0), Windows and Linux, CI, and a fully offline run —
catalog and registry lookups still leave the machine.

## Current baseline

- `make verify` runs deterministic lint, type, quality, Vitest, coverage, and
  supported Rust checks. It does not drive a desktop window.
- `make test-all` adds configured live sidecars, registries, and cloud
  contracts. It does not drive a desktop window.
- `tests/checklist.md` contains 239 unchecked or historical manual checklist
  items across migration, settings, Hub, threads, assistants, and installation.
- `autoqa/` contains one computer-use prompt, depends on an external UI model
  and host automation, uses Jan-era application assumptions, and is not called
  by a standard Make target or current GitHub workflow.
- Existing ADRs already require official Tauri mocks for frontend adapters,
  isolate Rust's unstable Tauri test API, and grade critical-flow evidence
  rather than counting tests.

## Scope

This plan adds deterministic browser, contract, packaged desktop, and
platform-acceptance coverage for the existing desktop product. It also turns
the manual checklist into a traceable acceptance catalog.

Mobile device automation, load testing, model-quality benchmarking, and a
general rewrite of `autoqa` are outside this rollout. They may consume the same
fixtures and case ids later.

## Completion criteria

The rollout is complete when:

1. every current checklist item has a stable case id, owner layer, platform
   scope, execution tier, and automated test or documented manual reason;
2. the six packaged desktop journeys in `testing-critical-flows.md` pass on
   macOS, Windows, and Linux where the product behavior exists;
3. pull-request tests are offline and never touch a user's application data,
   home configuration, model directory, credentials, or port 1337 service;
4. installer and legacy-profile migrations run from clean platform images and
   block release promotion when they fail;
5. every failure publishes enough evidence to reproduce the test without
   watching the entire run;
6. the evidence map records the owning test and grade for each P0 flow;
7. the role of `autoqa` is explicit: retained as exploratory tooling with a
   documented invocation, or removed by a later decision after its useful
   scenarios have deterministic replacements.

## Proposed repository layout

Use existing top-level directories:

```text
tests/
  acceptance/
    cases.yaml                 # stable case ids and coverage metadata
    fixtures/                  # small deterministic profiles and responses
  e2e/
    browser/                   # fast WDIO browser-mode journeys
    desktop/                   # packaged Tauri journeys
    shared/                    # selectors, case helpers, fixture clients
    wdio.browser.conf.ts
    wdio.desktop.conf.ts
docs/
  e2e-automation-plan.md       # this rollout plan
  testing-critical-flows.md    # evidence grades and remaining gaps
```

Generated reports belong in ignored build/test output, not in the repository.
No new top-level directory is required.

## Phase 0 — Inventory and classify acceptance cases

### Work

1. Merge the useful entries from `autoqa/checklist.md` and
   `tests/checklist.md`; retain source references while duplicates are resolved.
2. Give each case a stable id such as `ONB-001`, `CHAT-004`, `API-003`,
   `MIG-002`, or `PKG-WIN-001`.
3. For each case record:
   - priority and user-visible outcome;
   - production entrypoint or boundary;
   - owner layer: frontend, contract, desktop, or provisioned platform;
   - supported platforms;
   - fixture and network policy;
   - execution tier;
   - current test path and evidence grade;
   - manual reason, owner, and review date when automation is deferred.
4. Link existing Vitest and Rust evidence before creating new tests. A manual
   sentence that is already strongly proved below the UI should point to that
   evidence rather than receive a duplicate desktop journey.

### Exit criteria

- Every checklist item is accounted for exactly once.
- P0 cases have an owner layer and planned test path.
- The catalog validator rejects duplicate ids, unknown layers, missing
  platform scopes, and references to absent test files.

## Phase 1 — Create safe test seams

### Work

1. Centralize application-data resolution behind one production helper and
   add an `e2e`-only override for a temporary data root.
2. Provide an isolated home/config root for Launch integrations, MCP
   configuration, and other external-agent writers.
3. Add an `e2e`-only local API port override or dynamic port handshake. Expose
   the selected endpoint to the test harness.
4. Disable telemetry, autostart registration, update checks, public catalog
   refresh, and external browser opening in the e2e profile unless a scenario
   explicitly owns that integration.
5. Add a deterministic local fixture backend. It must support:
   - readiness and model listing;
   - ordered chat streaming and final completion;
   - cancellation;
   - tool-call events;
   - authentication and protocol errors;
   - configurable startup delay and process exit.
6. Seed profiles through public storage/schema boundaries. Avoid copying an
   operator profile or reaching into implementation-specific UI state.

### Exit criteria

- Two consecutive test runs use different temporary roots and leave the real
  Atomic Chat profile unchanged.
- A failed or interrupted run reaps the app and fixture backend.
- Tests can run while a developer profile exists without reading or modifying
  it.
- Tests do not require public network access.

## Phase 2 — Add the WDIO/Tauri harness

### Work

1. Add WebdriverIO test-runner dependencies and `@wdio/tauri-service` as
   development dependencies.
2. Add `tauri-plugin-wdio-webdriver` and `tauri-plugin-wdio` as optional Rust
   dependencies behind a Cargo feature named `e2e`.
3. Register both plugins only for that feature. Verify release builds do not
   contain or start the embedded driver.
4. Add browser and desktop WDIO configurations. Share semantic selectors and
   fixture clients, while allowing a scenario to remain desktop-only when its
   purpose is the native boundary.
5. Run desktop specs with one worker. The harness owns process startup,
   readiness, restart, shutdown, temporary paths, and ports.
6. Capture screenshots, frontend console, Rust logs, fixture logs, and the
   resolved environment on failure.
7. Add stable accessible names where production controls cannot be selected by
   role and label. Use test ids only when no user-facing semantic selector is
   possible.

### Exit criteria

- One browser journey and one packaged desktop journey pass locally.
- The desktop journey proves one real Tauri IPC call and observable result.
- Failure artifacts identify the case id, platform, app build, temporary
  profile, and relevant logs.
- A release build inspection proves the e2e plugins are absent.

## Phase 3 — Implement the critical desktop journeys

Implement the acceptance contract already defined in
`testing-critical-flows.md`, in this order:

1. **Clean onboarding and restart** — proves empty-profile startup, backend
   recommendation, completion, and persisted completion.
2. **Thread persistence across restart** — proves UI-to-storage-to-UI
   rehydration without a model dependency.
3. **Local OpenAI-compatible API** — proves UI server control plus external
   authentication, `/v1/models`, and streamed `/v1/chat/completions` against
   the fixture backend.
4. **Fixture model start and first reply** — proves progress, readiness,
   ordered stream rendering, and final assistant persistence.
5. **Launch integration** — proves isolated-home writes, unrelated-key
   preservation, and idempotency for one representative coding agent.
6. **Data-folder relocation** — proves successful relocation and rollback
   after an injected copy failure.

Each journey must include one meaningful failure assertion at the same
boundary. Split branch permutations into lower-layer tests rather than adding
UI steps.

### Exit criteria

- All six journeys pass against a packaged debug/test binary.
- Restart scenarios reuse only their own isolated profile.
- No journey downloads public model weights or requires a cloud credential.
- `docs/testing-critical-flows.md` names the owning tests and updates evidence
  grades based on what they actually prove.

## Phase 4 — Convert the remaining regression catalog

Work by risk, not by checklist order:

### P0 product paths

- onboarding failure and recovery;
- chat send, cancel, regenerate, edit, and persisted error;
- Hub install/delete/start using deterministic artifacts;
- provider enable/disable and model visibility;
- MCP lifecycle and permission decisions;
- local API configuration and request logging;
- data migration and reset safety.

### P1 daily workflows

- thread rename, search, favourite, delete, and ordering;
- assistants and sampling persistence;
- interface settings and reset;
- keyboard shortcuts and accessibility behavior;
- downloads pause, resume, cancellation, and recovery;
- Launch catalog detection and configuration variants.

### Platform and release paths

- clean install, update, uninstall, and retained data;
- legacy Jan-to-Atomic-Chat profile migration;
- tray, deep links, autostart, file dialogs, and external opener;
- backend choice on supported GPU/driver fixtures and representative machines;
- one pinned real backend and small acceptance model per supported provider
  family where licensing and runner capacity permit.

### Exit criteria

- Every automated catalog entry links to a passing test in its declared tier.
- Remaining manual cases state why automation cannot yet produce reliable
  evidence and when that reason will be reviewed.
- New product work adds or updates catalog cases in the same change.

## Phase 5 — CI and release gates

### Pull requests

- existing `make verify`;
- acceptance catalog validation;
- fast browser journeys;
- deterministic socket/process contracts;
- no public network, credentials, installers, or model downloads.

### Platform smoke

- packaged desktop journeys on Linux and Windows for relevant pull requests or
  protected-branch merges;
- macOS embedded-driver run on protected-branch merges;
- one worker per app instance;
- artifacts uploaded only on failure or when explicitly requested.

### Nightly

- full desktop matrix;
- live sidecars and selected real model/backend acceptance;
- hardware-specific runners where available;
- optional exploratory `autoqa` run whose findings do not directly determine
  release status.

### Release

- clean install and launch on every desktop platform;
- previous-release update with a versioned migration fixture;
- retained user data and rollback evidence;
- packaged backend provenance and minimal inference acceptance;
- all release-tier acceptance case ids present in the report.

### Exit criteria

- A failure names the acceptance case and evidence layer instead of only the
  CI job.
- Release promotion cannot proceed when a release-tier case is failed or
  missing.
- Flaky retries are measured and bounded; retry success does not erase the
  original failure artifact.

## Phase 6 — Resolve `autoqa`

After deterministic coverage owns the critical catalog:

1. inventory what `autoqa` still discovers that the deterministic suites do
   not;
2. update its Atomic Chat paths and dependencies if it remains useful for
   exploratory runs;
3. require every confirmed finding to produce a stable case id and a
   deterministic regression test;
4. remove it in a separate decision if its maintenance and model cost no
   longer produce unique findings.

`autoqa` must not become a release gate merely because it can navigate more
screens. Its result is exploratory evidence until a deterministic assertion
reproduces the finding.

## Risks and controls

- **False confidence from browser-only tests:** retain packaged desktop and
  platform journeys for native boundaries.
- **Slow native suites:** keep branch permutations below the UI and limit
  desktop tests to boundary-spanning outcomes.
- **User-data damage:** fail startup when the e2e profile is requested without
  an explicit temporary data root; print the resolved root in test logs.
- **Port and single-instance conflicts:** allocate test ports, serialize native
  runs, and ensure teardown owns every child process.
- **Fixture drift:** version fixtures with the production schema/protocol and
  fail on unrecognized fields or commands.
- **Platform divergence:** attach platform scope to every case and run native
  evidence on the OS whose WebView and integration are under test.
- **Model nondeterminism:** assert protocol, lifecycle, bounded output
  properties, and persistence. Keep semantic model-quality evaluation in a
  separate benchmark or acceptance system.

## First implementation slice

The first reviewable change should stop after it proves the harness:

1. add the acceptance catalog schema with mappings for the six critical
   desktop journeys;
2. add isolated data/home/port test seams;
3. add the feature-gated WDIO plugins and runner;
4. implement clean onboarding plus restart;
5. publish failure artifacts;
6. wire a non-release local command and one Linux CI smoke job.

This slice deliberately does not migrate the full checklist. It validates the
security boundary, process lifecycle, driver choice, and diagnostic quality
before the suite grows.

