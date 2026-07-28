# AGENTS.md — Atomic Chat

Operating instructions for AI coding agents in this repository.
Everything here applies to **every** task. Anything that applies only sometimes
lives behind a link — follow the link when the task needs it.

| Need                                    | Go to                                            |
| --------------------------------------- | ------------------------------------------------ |
| Why something is built the way it is    | [`docs/decisions/INDEX.md`](docs/decisions/INDEX.md) |
| Dev loop, data folders, troubleshooting | [`DEVELOP.md`](DEVELOP.md)                        |
| Product overview, install, API examples | [`README.md`](README.md)                          |
| Contribution conventions                | [`CONTRIBUTING.md`](CONTRIBUTING.md)              |

---

## 1. What this is

Cross-platform desktop/mobile app (Tauri + React) that runs LLMs locally and
exposes an OpenAI-compatible API at `http://localhost:1337/v1`. Three inference
backends sit behind that one facade; callers never need to know which is serving.

Targets: macOS (Universal), Windows x64, Linux (AppImage), iOS, Android.
Apple Silicon is first-class.

**Product name is Atomic Chat.** Hard fork of [Jan](https://github.com/janhq/jan);
much of the tree still carries `jan*` / `@janhq/*` names — see §4.

---

## 2. Repository map

| Path                                      | What lives there                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `web-app/`                                | Frontend: React + Vite + TanStack Router, Tailwind, shadcn. Workspace `@janhq/web-app`. |
| `web-app/src/routes/launch/`              | "Launch" page — install/configure external coding agents against the local API. Catalog: `web-app/src/constants/integrations.ts`; commands: `src-tauri/src/core/system/commands.rs`. |
| `core/`                                   | Shared TS core: types, browser runtime, extension contracts. Built + `yarn pack`'d, consumed by extensions. |
| `extensions/`                             | Pluggable backend extensions (TS, rolldown-bundled). Each has `src/`, `package.json`, `settings.json`. |
| `extensions/llamacpp-extension/`          | Driver for our `atomic-llama-cpp-turboquant` fork. **macOS only.**                    |
| `extensions/llamacpp-upstream-extension/` | Driver for stock `ggml-org/llama.cpp`. Provider id `llamacpp-upstream`. All platforms. |
| `extensions/mlx-extension/`               | Driver for the MLX-VLM backend. Apple Silicon only.                                   |
| `extensions/foundation-models-extension/` | Driver for Apple Foundation Models (macOS/iOS).                                       |
| `src-tauri/`                              | Rust/Tauri shell: `src/lib.rs`, `src/main.rs`, plugins, capabilities, bundle configs.  |
| `mlx-server/`, `foundation-models-server/`| Swift sidecars. Built via `make build-mlx-server` etc.                                 |
| `pre-install/`                            | Pre-built extension tarballs bundled into the installer. Still named `janhq-*-*.tgz` (legacy, load-bearing). |
| `scripts/`                                | Build, packaging, signing, download helpers.                                          |
| `docs/`                                   | Public docs site (Next.js/MDX) + `docs/decisions/` (ADR log).                          |
| `benchmarks/`, `autoqa/`, `tests/`        | Throughput benchmarks, automated QA harness, top-level Vitest.                         |

Our own upstream repos, checked out next to this one under `/Users/misha/Work/Atomic/`:

- [`AtomicBot-ai/mlx-vlm`](https://github.com/AtomicBot-ai/mlx-vlm) — MLX backend (fork of `Blaizzy/mlx-vlm`).
- [`AtomicBot-ai/atomic-llama-cpp-turboquant`](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant) — TurboQuant llama.cpp fork, branch `feature/turboquant-kv-cache`.

---

## 3. Backends — the part that is easy to get wrong

**Which llama.cpp ships where:**

| Platform | Provider(s)                                   | TurboQuant KV/weights, Gemma 4 MTP, Qwen NextN |
| -------- | --------------------------------------------- | ---------------------------------------------- |
| macOS    | `llamacpp` (our fork) **+** `llamacpp-upstream` | yes, on the fork provider only                 |
| Windows  | `llamacpp-upstream` only                       | **no**                                         |
| Linux    | `llamacpp-upstream` only (Vulkan is the sole GPU path) | **no**                                 |

Consequences you must respect:

- Fork-only flags (`-ctk`/`-ctv turbo*`, `--mtp-head`, `--spec-type mtp\|nextn`)
  must be guarded by a platform/backend check before reaching the UI. They do
  not exist on Windows or Linux.
- `download-llamacpp-backend` is a no-op on Windows and skips on Linux;
  `download-llamacpp-upstream-backend` is the one that matters there.
- On Linux there is no CUDA/HIP path. NVIDIA, AMD and Intel all share
  `linux-vulkan-x64`.

**MLX** (Apple Silicon): `mlx-server/` Swift sidecar wrapping `mlx_vlm.server`,
driven by `extensions/mlx-extension/`. Speculative decoding via `--draft-kind
dflash|eagle3|mtp`; KV quantization via `--kv-bits` / `--kv-quant-scheme`.

**Apple Foundation Models**: macOS/iOS only. Out of scope unless asked.

Details, flags and the reasoning behind each of these choices are in
[`docs/decisions/INDEX.md`](docs/decisions/INDEX.md) — sections *llama.cpp
providers*, *Speculative decoding*, *MLX*.

---

## 4. Naming: what you may not rename

Legacy `jan*` names are load-bearing for installer migrations, pre-install
tarball paths, Windows APPDATA folders and the bundle-id split. Renaming them
opportunistically breaks existing user installs.

| Surface                  | Value                  | Rule                        |
| ------------------------ | ---------------------- | --------------------------- |
| Root `package.json` name | `jan-app`              | leave — rename = migration  |
| Web app workspace        | `@janhq/web-app`       | leave                       |
| Pre-install tarballs     | `janhq-*-*.tgz`        | leave — installer expects it |
| Tauri CLI binary         | `jan-cli`              | leave                       |
| `Cargo.toml` repo URL    | `github.com/janhq/jan` | leave                       |
| Tauri bundle id          | `chat.atomic.app`      | use this                    |
| Cargo crate              | `Atomic-Chat`          | use this                    |
| Product name             | `Atomic Chat`          | use this                    |

**All new** modules, packages, env vars, log prefixes, CLI subcommands,
telemetry events, user-facing strings and docs use `atomic` / `Atomic Chat`.
Wiring new code into an existing `@janhq/*` package is fine; adding a new
`jan*` identifier is not.

---

## 5. Commands

```bash
make dev      # first-time setup: deps, core, extensions, icons, launch Tauri
yarn dev      # hot loop after make dev has run once
make build    # production build (see Makefile / package.json for per-platform targets)
make test     # vitest + lints
yarn lint     # eslint in @janhq/web-app
```

Mobile builds use `--features mobile`. Per-OS runtime data paths — including
the three legacy Windows APPDATA folders — are documented in `DEVELOP.md`.
Do not invent new data paths.

---

## 6. Rules

These are additional to the user's global engineering rules and override
defaults on conflict.

1. **Do only what was asked.** No opportunistic refactors, no "while I'm here"
   cleanups. Tempting improvement → propose it, don't ship it.
2. **Don't fabricate backend behaviour.** Unsure about an `mlx-vlm` or
   `atomic-llama-cpp-turboquant` flag? Read that repo's `README.md` / `MTP.md` /
   `NEXTN.md` / `docs/speculative.md`. Both are checked out locally.
3. **OpenAI-compat is a contract.** `http://localhost:1337/v1` must stay
   OpenAI-compatible — OpenCode, Codex, Hermes and others depend on it. Adding
   non-standard fields is fine; breaking standard ones is not.
4. **Verify before you finish.** TS/JS: `yarn lint` + `yarn test` in the
   affected workspace. Rust: `cargo check` and `cargo clippy` in `src-tauri/`.
5. **Never commit unless explicitly asked.**
6. **No new top-level folders, config files or runtime dependencies** without
   the user's explicit "ok" (name + reason first).
7. **No destructive commands** — `rm -rf`, `git push --force`, `cargo clean
   --release`, deleting user data folders — without explicit confirmation.
8. **Record non-trivial decisions** as a new file in `docs/decisions/`
   (architecture, backend selection, perf trade-off, security default, schema
   or migration). Same session, before you finish. See §7.

---

## 7. Keeping this file small

`AGENTS.md` is loaded into context on every single task, so its size is a tax
on every task. Hard limits:

- **Target ≤ 200 lines. Never exceed 300.** If an edit pushes it over, move
  something out to a linked doc in the same edit.
- **No decision log in this file.** Each ADR is its own file under
  `docs/decisions/` (template: `_TEMPLATE.md`), indexed one line per record in
  `docs/decisions/INDEX.md`. Never inline a record here.
- **At most 10 ADRs may be referenced from this file**, and only ones that
  change how you write code today — the standing platform/provider policies.
  Everything else is reachable via the index.
- **No duplication.** If a fact already lives in `README.md`, `DEVELOP.md`,
  `CONTRIBUTING.md` or an ADR, link to it instead of restating it. When they
  disagree, the linked doc wins and this file gets fixed.
- Prefer a table or an imperative rule over a paragraph. Delete anything a
  competent agent would infer from the code in under a minute.
