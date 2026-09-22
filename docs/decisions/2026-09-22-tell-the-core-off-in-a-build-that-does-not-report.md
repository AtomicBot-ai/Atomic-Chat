---
date: 2026-09-22
title: "Tell the core \"off\" in a build that does not report"
---

# 2026-09-22 — Tell the core "off" in a build that does not report

- **Context:** The core now owns its error reporting (core ADR `2026-09-22-the-core-owns-its-error-reporting`). It carries its own DSN and reports by default unless its host says off. The app used to pass only the user's `productAnalytic` consent, which defaults to on. A `tauri dev` session, a test build and `make test-core-live` would therefore let the core report developer failures to the production project, even though the app's own Sentry stays off in those builds.
- **Decision:** The app tells the core `consent && this build reports` (`telemetry::core_consent`), both as the launch flag `--telemetry on|off` and in every `PUT /atomic/v1/telemetry`. "This build reports" means `telemetry::init` found a DSN in a non-development environment. `make test-core-live` also runs the core in the `development` environment.
- **Consequences:**
  - Release builds behave as before: the core reports under the user's consent.
  - Dev and test builds never report from the core.
  - `GET /telemetry` now also answers `source` and `host` (`atomic-chat`); the app does not read them.
- **Owner:** team.
- **Links:** `src-tauri/src/core/telemetry/{mod,core_state}.rs`, `src-tauri/src/core/atomic_core/{launch,supervisor,live_tests}.rs`, `Makefile` (`test-core-live`).
