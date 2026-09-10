---
date: 2026-06-02
title: "Surface MLX KV-cache quantization (TurboQuant / uniform) as a provider setting"
---

# 2026-06-02 — Surface MLX KV-cache quantization (TurboQuant / uniform) as a provider setting

- **Context:** The MLX backend (`AtomicBot-ai/mlx-vlm`) supports KV-cache
  quantization on its CLI (`--kv-bits <float> --kv-quant-scheme
  uniform|turboquant`; the server only sets `KV_BITS` when `--kv-bits` is
  passed, so the cache is full-precision by default). After the v0.6.0 sync
  the engine capability was present but **nothing in the desktop app drove
  it** — the `tauri-plugin-mlx` Rust shim only emitted `--max-kv-size`,
  `--draft-model`, `--draft-kind`, `--draft-block-size`. Users could not opt
  into TurboQuant KV (the recommended `--kv-bits 3.5 --kv-quant-scheme
  turboquant`, ~4.3× smaller cache) to fit longer contexts.
- **Decision:** Add two MLX provider settings and plumb them end-to-end as a
  **load-time** arg (mirrors `ctx_size`: applied on the next model load, no
  mid-session auto-reload like the drafter block-size path):
  - `extensions/mlx-extension/settings.json`: `kv_quant_scheme` dropdown
    (`off` (default) / `turboquant` / `uniform`) + `kv_bits` number input
    (default `3.5`, range 0–8).
  - `performLoad` in `extensions/mlx-extension/src/index.ts` normalizes
    `off` → `''` and forces `kv_bits = 0` when the scheme is off, so a stale
    bit-width can't leak; both ride the existing `MlxConfig` IPC.
  - `tauri-plugin-mlx` `MlxConfig` gains `kv_bits: f32` + `kv_quant_scheme:
    String` (both `#[serde(default)]`); `load_mlx_model_impl` emits
    `--kv-bits <bits> --kv-quant-scheme <scheme>` **only** when the scheme is
    `uniform`/`turboquant` AND `kv_bits > 0.0`. guest-js `types.ts` /
    `normalizeMlxConfig` carry the matching fields.
- **Consequences:**
  - Backwards-compatible: empty/legacy configs (and `off`) emit no KV flags,
    so the server keeps its full-precision default — no behavior change for
    existing users. The single source of truth for "is KV quant on" is the
    Rust guard (scheme ∈ {uniform, turboquant} && bits > 0).
  - Quality/latency trade-off is the user's: TurboQuant @ 3.5 bits is the
    documented sweet spot; uniform pairs with 4/8. Wrong pairings only cost
    quality, never correctness.
  - macOS-only surface (MLX provider is Apple-Silicon-only); Windows/Linux
    unaffected. `cargo check` on `tauri-plugin-mlx` passes.
  - Not done: no per-keystroke auto-reload (intentional — KV geometry is
    fixed at cache allocation); no `--kv-group-size` / `--quantized-kv-start`
    exposure (kept on mlx-vlm defaults, can be added later if needed).
- **Owner:** team.
- **Links:** §4.1 *MLX backend*,
  [`extensions/mlx-extension/settings.json`](extensions/mlx-extension/settings.json),
  [`extensions/mlx-extension/src/index.ts`](extensions/mlx-extension/src/index.ts),
  [`src-tauri/plugins/tauri-plugin-mlx/src/commands.rs`](src-tauri/plugins/tauri-plugin-mlx/src/commands.rs),
  [`src-tauri/plugins/tauri-plugin-mlx/guest-js/types.ts`](src-tauri/plugins/tauri-plugin-mlx/guest-js/types.ts).
