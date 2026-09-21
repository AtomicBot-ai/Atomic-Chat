---
date: 2026-09-18
title: "Drive the desktop UI through an embedded WebDriver on an isolated profile"
---

# 2026-09-18 — Drive the desktop UI through an embedded WebDriver on an isolated profile

- **Context:** [Automate acceptance with layered Tauri evidence](2026-09-16-automate-acceptance-with-layered-tauri-evidence.md)
  chose WebdriverIO with the Tauri service for packaged desktop journeys, and
  named the seams it would need: a test-only build feature, isolated data and
  home directories, test ports, a deterministic backend. Nothing launched the
  window yet, and after the inference core moved out of the app every remaining
  acceptance gap in `atomic-chat-core`'s `PLAN.md` read "live Tauri UI not
  verified". Building the first slice on macOS showed what those seams have to
  cover on a developer's machine, where the test build runs next to the
  developer's own Atomic Chat:
  - the default data folder is named after the product, not the bundle
    identifier, and an existing legacy config folder is preferred — a different
    identifier alone leaves the test build in the real profile;
  - WebKit keys the default data store of an unbundled binary by executable name
    (`~/Library/WebKit/Atomic-Chat`), shared by every dev build, and redirecting
    HOME does not move it; `dataStoreIdentifier` in a window config is dropped
    before it reaches the webview (tauri-runtime 2.10) and rejected by the CLI's
    schema (2.8.4);
  - a clean profile installs the CLI onto the operator's PATH, connects to the
    one MCP server that ships enabled, creates `~/Documents/Atomic_chat`, binds
    the local API server to 1337, and its onboarding imports and starts models
    found in the operator's LM Studio, Hugging Face and Ollama folders;
  - the app's orphan reaper scans the build's resource directory, which for an
    unbundled binary is the cargo output directory a `yarn dev` session uses;
  - after launch the upstream extension compares the configured backend with the
    newest one it knows and downloads the newer without asking;
  - closing the window hides the app on macOS, and a killed app leaves its core
    daemon alive until its registration expires.
- **Decision:** Desktop journeys run the shipped app built with `--features e2e`,
  which embeds `tauri-plugin-wdio-webdriver`, and are driven by the plain
  `webdriverio` client under Vitest from `tests/e2e/`. This narrows the earlier
  decision: no `@wdio/tauri-service` and no `tauri-plugin-wdio`, because the
  harness has to own the process — relaunch on the same profile, launch expecting
  a refusal, hard stop — and needs none of the service's mocking; real commands
  are invoked from the page through `__TAURI_INTERNALS__`. The frontend is
  changed for testing only by adding a test id where a control has no handle
  at all (so far one: the provider settings button in the model picker). Isolation is enforced by the build, not trusted to the
  runner:
  - the build exits with code 2 unless `ATOMIC_E2E_DATA_ROOT` names an existing
    absolute directory, and again if the resolved data folder ends up outside it;
  - the inputs of path resolution are redirected into that root (config file,
    default data folder, and their AppHandle-free twins), not its result, so
    relocating the data folder stays testable;
  - Tauri is told not to create the configured windows; `setup` builds the same
    windows from the same config with a WebKit data store derived from the root,
    so each profile gets an empty webview that survives a restart;
  - an initialization script seeds localStorage from `<root>/webview-seed.json`
    once per profile (the runner turns the API server's auto-start off and gives
    it a free port) and collects page errors for failure artifacts;
  - the startup CLI install is compiled out, and the windows are kept on top:
    WebKit gives a fully covered window no animation frames, the app removes its
    full-window splash overlay from one, and on a machine somebody is working on
    that overlay otherwise stays over the UI and swallows every click. Tray,
    close-to-tray, single instance, the reaper, MCP start-up and the updater
    plugin stay as shipped.
  The runner supplies the rest: an environment built from an allowlist with a
  stand-in HOME, an MCP config with no servers, and the core's own fake
  llama-server from the sibling `atomic-chat-core` checkout, installed as
  `b99999/macos-arm64` so that it is always the newest backend and nothing is
  ever downloaded in its place. It refuses a binary without the isolation marker,
  `make test-app-e2e` refuses a build older than its sources, every scenario ends
  by asserting that the operator's profile, CLI and WebKit stores are unchanged
  and that no process started from the profile outlived it, and teardown stops
  the app before the core because a live app restarts a stopped core. The core
  is asked to shut down with `force`: a killed app's registration stays attached
  for some 45 s, an unforced shutdown is refused meanwhile, and killing the core
  instead orphans the backends it never got to stop. The build has its own target directory (`src-tauri/target/e2e`),
  carries no telemetry key, points the registries at a closed port, and builds
  the web app without yarn.
- **Consequences:** `make build-app-e2e` and `make test-app-e2e` give a
  deterministic window-level check in a few minutes, outside `make verify`.
  Which journeys exist, what each proves and what it does not is kept in
  [`docs/testing-critical-flows.md`](../testing-critical-flows.md), not here.
  An e2e build differs from the shipped one in the
  identifier, the updater endpoint, who creates the configured windows (and that
  they float on top), where path resolution starts and the missing CLI install; `tests/e2e-config.test.mjs`
  keeps the config copy and the wiring from drifting. Costs and limits: macOS
  arm64 is the only verified platform. The harness keeps every OS fact in
  `tests/e2e/harness/platform.ts` and fails loudly on an unported one instead
  of guessing; the build sets both a WebKit data store identifier and a webview
  data directory so that Windows and Linux keep webview data inside the root,
  but that half has never run. The fake backend is a shell script, so its
  scenarios are skipped on Windows, which needs a real `llama-server` and a
  tiny GGUF; a second full compile and its disk space;
  windows the frontend creates lazily (logs, system monitor) are not given the
  profile's WebKit store, so journeys must not open them until they are; the
  slice is not offline — catalog and registry lookups still leave the machine,
  and only backend downloads are asserted absent; the app installs packed
  extensions without a version check, so `build-app-e2e` refuses tarballs older
  than their sources or carrying an unbundled plugin import, which happens when
  `yarn build:extensions` runs before `yarn build:tauri:plugin:api`.
- **Owner:** team
- **Links:** `src-tauri/src/core/e2e.rs`, `src-tauri/tauri.e2e.conf.json`,
  `tests/e2e/`, `tests/e2e-config.test.mjs`, `Makefile` (`build-app-e2e`,
  `test-app-e2e`), [`docs/e2e-automation-plan.md`](../e2e-automation-plan.md),
  [`docs/testing-critical-flows.md`](../testing-critical-flows.md),
  [tauri-plugin-wdio-webdriver](https://github.com/webdriverio/desktop-mobile/tree/main/packages/tauri-plugin-webdriver)
