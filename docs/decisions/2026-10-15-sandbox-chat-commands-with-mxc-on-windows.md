---
date: 2026-10-15
title: "Sandbox chat commands with Microsoft MXC on Windows"
---

# 2026-10-15 — Sandbox chat commands with Microsoft MXC on Windows

- **Context:** Chat can now run commands and scripts
  (`2026-10-15-run-commands-and-scripts-from-chat.md`). On Windows we use
  Microsoft's MXC (MIT, 1.0.0 since 2026-10-06), as planned with Microsoft.
  Unsloth Studio uses it too, but pinned to the `0.8.0-alpha` request schema,
  which current releases reject; its code is AGPL-3.0, so only the approach is
  reused.
- **Decision:**
  - **Executor:** `wxc-exec.exe` from `@microsoft/mxc-sdk` 1.0.0, x64 or arm64,
    bundled as `resources/bin/mxc/wxc-exec.exe`. `scripts/download-bin.mjs`
    pins the npm tarball (size + sha256) and each executor's sha256; the release
    jobs check its Authenticode signature is Microsoft's. `wxc-host-prep.exe` is
    not shipped. Run as a separate process with `--config-base64` (not the
    `mxc-sdk` crate), so a sandbox crash cannot take the app down.
  - **Tier:** only the built-in process isolation (`base-container`, Windows 11
    24H2 + the August 2026 update or newer): `fallback.allowDaclMutation:
    false`, never an administrator step, never a folder ACL change.
  - **When:** whenever the session's probe passed — `wxc-exec --probe` must name
    the base container, and a test run must write inside its folder and fail to
    read a file next to it — whatever the approval mode, Full access included
    (it removes prompts, not the sandbox).
  - **Request (contract 1.0.0):** the chat folder is the only `readwritePaths`
    entry; `%SystemRoot%`, the app's bin folders, the managed Python, the
    script runtime's install root and the user's PATH folders are read-only;
    the environment is built from scratch (`SYSTEMROOT`, and `LOCALAPPDATA`,
    `APPDATA`, `HOMEDRIVE`/`HOMEPATH` pointing at the chat folder); network
    egress allowed, ingress denied; clipboard and input injection closed; MXC
    enforces the call's timeout, the host kills the executor 15 s later.
  - **Without MXC** (older Windows, a failed probe, no executor in the build):
    the call runs on the host and the approval dialog says so, with the reason.
    If MXC reports a pre-launch failure mid-session, the app probes again and
    only the probe's answer can drop the sandbox — the workload controls its own
    stderr, so a printed error line never does. A sandboxed call is never re-run
    on the host.
- **Consequences:** On supported Windows a command cannot read the user's files
  outside the chat folder or write anywhere else; the tool description tells the
  model so. Installers grow by ~12 MB (x64) / ~6 MB (arm64). Known MXC 1.0
  limits apply inside the sandbox: git and MSYS2 tools (Git Bash) do not work
  (microsoft/mxc#1464, #1061), Python asyncio may hang on its loopback socket
  pair (#1261), and network rules are not verified by the probe. Updating MXC
  means new pins in `download-bin.mjs` and a run of the Windows checks below.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/chat_exec/mxc.rs`,
  `src-tauri/src/core/chat_exec/commands.rs` (`detect_sandbox`, `recheck_sandbox`),
  `scripts/download-bin.mjs` (`MXC`), `src-tauri/tauri.windows.conf.json`,
  `src-tauri/tauri.windows-arm64.conf.json`, `.github/workflows/release.yml`,
  https://github.com/microsoft/mxc, `docs/containment-policy/1.0.0/policy.md` there.
