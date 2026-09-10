---
date: 2026-08-05
title: "Expose version-gated reasoning preservation and direct llama-server arguments"
---

# 2026-08-05 — Expose version-gated reasoning preservation and direct llama-server arguments

- **Context:** Both bundled llama.cpp providers support more server options than Atomic Chat's typed provider settings expose. In particular, supported chat templates can preserve prior reasoning, but users could neither enable `--reasoning-preserve` nor pass newly added llama-server options without an app release.
- **Decision:** Add a typed reasoning-preservation toggle gated to upstream build b9837 or newer, plus an advanced argument string for both llama.cpp providers. Parse the string into direct process arguments without invoking a shell, preserve quoted values and Windows paths, reject malformed quoting, and append valid arguments after managed arguments.
- **Consequences:** Compatible models can retain reasoning across turns, and power users can use new llama-server options immediately. Extra arguments can override managed options when llama-server accepts repeated flags and can also prevent startup when unsupported or invalid options are supplied; shell expansion and command substitution are intentionally unavailable.
- **Owner:** team
- **Links:** [ATO-402](https://linear.app/atomicchat/issue/ATO-402/llamacpp-prokinut-reasoning-preserve-pole-dlya-proizvolnyh-argumentov), `src-tauri/plugins/tauri-plugin-llamacpp/src/args.rs`, `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs`
