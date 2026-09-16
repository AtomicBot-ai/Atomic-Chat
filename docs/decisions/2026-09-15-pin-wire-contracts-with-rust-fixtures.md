---
date: 2026-09-15
title: "Pin wire contracts with Rust fixtures"
---

# 2026-09-15 — Pin wire contracts with Rust fixtures

- **Context:** The core re-implements behaviour whose only specification is
  Rust code: `llama-server` argv rules with build-number gates, the stderr
  error cascade and its `{code,message,details}` shape, runtime-device and
  `--list-devices` parsing, the Responses/Chat shims and the
  `local-api-server.json` state file. Reading the Rust and hoping the port
  matches is not evidence; f32 rounding, tie-breaks and empty-string defaults
  already differed on first port.
- **Decision:** Each Rust module that defines a contract gets an
  `#[ignore]`-gated `fixture_dump` test that writes JSON cases
  (`{name, source:{file,commit}, comparator, input, expected}` plus an
  `index.json`) to `tests/fixtures/core-contracts/<set>/`. The core imports
  them with a checksum; `tests/core-contracts.test.mjs` here checks the same
  checksum and the case schema. Each set names its comparator (`argv-exact`,
  `error-exact`, `runtime-device-exact`, `devices-exact`, `json-exact`,
  `sse-sequence`, `state-file-schema`). Dynamic fields are replaced by explicit
  placeholders, never dropped. Changing a fixture's meaning requires an ADR in
  both repositories.
- **Consequences:** Emitters are test-only code and can be deleted to roll
  back. Behaviour changes in Rust become visible as checksum drift on the core
  side. The emitters run on demand (`cargo test -- --ignored dump_fixtures`),
  so contributors must re-run them and re-import when they touch a pinned
  module.
- **Owner:** team
- **Links:** `tests/fixtures/core-contracts/`, `tests/core-contracts.test.mjs`,
  `../../../atomic-chat-core/scripts/import-app-fixtures.mjs`,
  `../../../atomic-chat-core/docs/contracts.md`,
  [Extract the inference core](2026-09-15-extract-the-inference-core-into-atomic-chat-core.md)
