---
date: 2026-10-15
title: "Let chat commands reach the user's Desktop, Documents and Downloads"
---

# 2026-10-15 — Let chat commands reach the user's Desktop, Documents and Downloads

- **Context:** The first live test of chat commands on macOS went wrong
  three times in a row:
  - "How many files are on my desktop?" ran `ls -1 | wc -l` in the chat's
    scratch folder and answered "0".
  - "Create a text file there" wrote to the relative `Desktop/example.txt`,
    failed, and the model concluded it had no access.
  - Only "run it yourself on the Mac" produced `~/Desktop/…`, which raised
    macOS's folder-access prompt and worked.

  The tool description had told the model to use relative paths in the chat
  folder and never said where the user's files are. On Windows the MXC policy
  (`2026-10-15-sandbox-chat-commands-with-mxc-on-windows.md`) made the chat
  folder the only writable place, so the same request could not work there
  at all. Linux XDG folders are often localized ("Рабочий стол"), and
  Windows known folders often live in OneDrive, so "~/Desktop" is not a
  safe guess either.
- **Decision:**
  - **Name the folders.** `chat_exec_status` resolves the user's Desktop,
    Documents and Downloads through Tauri's path API, which reads XDG user
    dirs and Windows known folders. It returns them as `userFolders`:
    - macOS/Linux: as `~/…`, so no user name reaches the model;
    - Windows: absolute, because cmd has no `~`.

    The `run_command` / `run_script` descriptions say that the working
    directory is a scratch folder (a relative `Desktop/x` lands in it), list
    the user's folders, and say to use them for the user's files. When a
    folder name contains a space, they add how to quote a `~` path.
  - **Windows sandbox.** These three folders join the chat folder in MXC's
    `readwritePaths`. Everything else stays out of reach: AppData, `.ssh`,
    the rest of the profile and the system. This supersedes the
    "chat folder is the only writable place" part of the MXC record; the
    rest of that record stands.
  - **When the OS refuses.** A failed call gets a `hint` that is appended to
    what the model reads:
    - macOS "Operation not permitted": allow Atomic Chat in System Settings →
      Privacy & Security → Files and Folders;
    - access denied inside MXC: only the chat folder and the three user
      folders are reachable.

    The model then explains the refusal instead of claiming it has no access.
  - **macOS prompt text.** `Info.plist` gains
    `NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`
    and `NSDownloadsFolderUsageDescription`, so the system prompt says why
    Atomic Chat asks.
- **Consequences:**
  - "Put it on my desktop" works on all three OSes. Every call still goes
    through the approval mode.
  - On Windows an approved command can now change files in those three
    folders. The approval dialog says so.
  - macOS still asks once per protected folder, at the first command that
    touches it. The command waits for the answer.
  - A dev build started from a terminal may show the prompt under the
    terminal's name rather than Atomic Chat's.
  - Windows folder paths include the user name and reach the model.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/chat_exec/commands.rs` (`user_folders`, `folder_for_model`, `failure_hint`),
  `src-tauri/src/core/chat_exec/mxc.rs` (`writable_roots`), `web-app/src/lib/chat-exec-tools.ts`,
  `src-tauri/Info.plist`.

<!--
Supersedes: 2026-10-15-sandbox-chat-commands-with-mxc-on-windows.md (only the "chat folder is the only writable place" rule)
-->
