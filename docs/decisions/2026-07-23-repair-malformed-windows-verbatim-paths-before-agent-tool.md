---
date: 2026-07-23
title: "Repair malformed Windows verbatim paths before Agent tool execution"
---

# 2026-07-23 — Repair malformed Windows verbatim paths before Agent tool execution

- **Context:** Agent could receive a Windows extended path with one leading
  slash (`\?\C:\...`) after JSON generation instead of the valid
  `\\?\C:\...` form. Rust treated that malformed form as relative, so a request
  to write to a selected folder was redirected beneath the Agent workspace.
- **Decision:** Normalize the exact malformed `\?\` prefix to `\\?\` at the
  shared Agent path-input boundary before absolute-path resolution. Preserve
  ordinary absolute, valid verbatim, relative, home-relative, and attachment
  paths unchanged.
- **Consequences:** Files requested through malformed drive or UNC verbatim
  paths resolve to their intended external location and retain the existing
  approval gate. Windows tests cover plain absolute, valid verbatim, and
  malformed verbatim write targets.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/path_policy.rs`](src-tauri/src/core/agent/path_policy.rs).

---
