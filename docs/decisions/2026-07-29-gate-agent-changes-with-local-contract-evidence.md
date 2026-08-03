---
date: 2026-07-29
title: "Gate agent changes with local contract evidence"
---

# 2026-07-29 — Gate agent changes with local contract evidence

- **Context:** Atomic Chat had broad unit coverage but no single local gate,
  no regression floor for critical files, and no executable compatibility
  contract for pinned inference binaries or moving registries. Several tests
  also rendered replacement fixtures instead of production entrypoints.
- **Decision:** Agent-authored changes pass `make verify`: deterministic test
  quality guards, pinned external contracts, critical-file coverage floors,
  root and extension Vitest, and platform-supported Rust suites. Live binary,
  registry, and cloud acceptance stays opt-in under `make test-live` and
  `make test-live-cloud`; sanitized cassettes remain reviewable fixtures.
- **Consequences:** New false-confidence patterns and critical-flow coverage
  regressions fail locally before push. Backend pin updates now require a
  capability-snapshot diff. The fast gate is more expensive because it gathers
  coverage, while live acceptance still depends on developer hardware, model
  files, and provider credentials.
- **Owner:** team
- **Links:** `Makefile`, `tests/coverage-floor.json`,
  `tests/test-quality-allowlist.json`, `docs/testing-critical-flows.md`
