---
date: 2026-10-15
title: "Grant directory enumeration and decode Windows chat output"
---

# 2026-10-15 — Grant directory enumeration and decode Windows chat output

- **Context:** In v2.2.10, `dir` on the user's Downloads failed inside MXC
  even though the folder was already writable. The command queries ancestor
  and volume metadata that the policy did not grant. Native Russian stderr
  was decoded as UTF-8, hiding the access-denied error behind replacement
  characters. The original probe only wrote a file and checked a denied read;
  it never listed a directory.
- **Decision:** Add the ancestors of the granted folders to MXC's
  `processContainer.filesystem.enumeratePaths`. Require the executor probe's
  `baseContainerSupportsEnumeratePaths` capability before offering MXC, and
  make the live probe list its folder as well as checking isolation. Use the
  existing console decoder for captured chat output: UTF-8 first, then the
  Windows OEM code page. Preserve UTF-8 when bounded capture splits a character.
- **Consequences:** Directory listing works while file reads and writes stay
  confined to the existing grants. Ancestor enumeration exposes directory
  names/metadata, not file contents. Never replace it with read-only profile
  or volume grants: the local Windows regression test demonstrated that a
  read-only volume grant exposed an otherwise blocked sibling file. Windows
  without native enumeration follows the existing unavailable-sandbox flow,
  with the reason shown before host execution; no failed workload is retried
  on the host. No ACL changes or new dependencies are needed.
- **Owner:** `team`.
- **Links:** `src-tauri/src/core/chat_exec/mxc.rs`,
  `src-tauri/src/core/chat_exec/runner.rs`,
  `src-tauri/src/core/chat_exec/mxc_windows_tests.rs`,
  `src-tauri/src/core/system/commands.rs`,
  [Microsoft MXC #1109](https://github.com/microsoft/mxc/issues/1109),
  [Microsoft MXC #1162](https://github.com/microsoft/mxc/issues/1162).

<!--
Supersedes: 2026-10-15-sandbox-chat-commands-with-mxc-on-windows.md (adds native enumeration to the eligibility check and policy; content grants remain unchanged)
-->
