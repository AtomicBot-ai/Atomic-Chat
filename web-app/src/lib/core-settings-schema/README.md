# Core settings schema (vendored)

Byte-exact copies of the local engines' settings descriptors from
`atomic-chat-core/src/settings/schema/` (`llamacpp.json`, `llamacpp-upstream.json`,
`mlx.json`, `tensorrt-llm.json`, `vllm.json`). `vllm.json` comes from the core's
`change/add-vllm-runtime` branch until the core release with that change is
pinned (openspec change `add-vllm-runtime`, task 6.3). The copy is pinned to the
core version named in the root
`package.json` under `atomicCore.version`; when that version changes, copy the
files again from the matching core source with `cp` (never retype them) and
recompute `CHECKSUM`. The branch pins `0.7.5`, which is not released yet
(openspec change `add-tensorrt-llm-linux`, task 3.11): until it is (task 7.1),
the matching source is the core's `change/add-tensorrt-llm-linux` branch.

`CHECKSUM` is the sha256 hex digest over every file in this directory except
`CHECKSUM` itself, in sorted name order, feeding each file's name bytes and then
its content bytes — the algorithm `tests/core-contracts.test.mjs` uses.
`tests/core-settings-schema.test.mjs` checks the digest, that each file still
equals the engine extension's `settings.json`, and, when the core source is
available, that each file equals the core's.

`web-app/src/lib/engine-settings-defaults.ts` reads these for "Reset to default".
