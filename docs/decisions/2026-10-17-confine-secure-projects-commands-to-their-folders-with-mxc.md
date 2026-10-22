---
date: 2026-10-17
title: "Confine a secure project's commands to its folders with MXC"
---

# 2026-10-17 — Confine a secure project's commands to its folders with MXC

- **Context:** Users want a project whose chats' agent can reach only the
  folders they chose, and nothing else on the computer. The chat's file
  reach comes from `run_command` / `run_script`
  (`2026-10-15-run-commands-and-scripts-from-chat.md`); only Windows confines
  them, with MXC (`2026-10-15-sandbox-chat-commands-with-mxc-on-windows.md`),
  whose policy opened the chat folder plus Desktop, Documents and Downloads
  (`2026-10-15-let-chat-commands-reach-the-users-own-folders.md`). macOS and
  Linux run commands on the host. Projects live only in the webview's
  localStorage.
- **Decision:**
  - **Policy.** A project can be a *secure environment*: a list of folders,
    each read-only or editable, and an internet switch (default on). It is
    kept by the backend in `<data>/secure-environments.json`
    (`core/secure_env`, `secure_env_list` / `secure_env_set`), not in the
    project's localStorage record. A folder must be an existing absolute
    directory, not a volume root, and neither inside nor around the app's
    data folder (other chats live there).
  - **Enforcement.** `chat_exec_run` looks the policy up itself, from the
    thread's own `thread.json` (`metadata.project.id`), so a frontend that
    forgets to pass it cannot widen a run. The MXC request then has the chat
    folder plus the project's editable folders as `readwritePaths`, its
    read-only folders added to `readonlyPaths`, no user folders, and — with
    the internet off — `egress.default: "deny"` and no `internetClient`
    capability. A damaged policy file is an error, never "no policy".
  - **No directory enumeration.** The policy's `enumeratePaths` is empty.
    Tested on Windows 11 26H2 with MXC 1.0: an enumeration grant covers the
    whole subtree, and `dir` works only when every ancestor up to the volume
    root is granted — so the ancestor grants that made `dir` work listed
    every folder on the drive (a secure chat read out Documents' file names
    and sizes; contents stayed denied). Without them `dir` and `cd` fail even
    on the project's folders, while `for %f in ("<folder>\*")` lists them and
    lists nothing elsewhere; the tool description and the failure hint tell
    the model so. The session probe lists its folder with `for`, checks that
    the folder around it stays unlisted, and no longer requires
    `baseContainerSupportsEnumeratePaths`.
  - **Without MXC** a secure thread's command is refused and nothing runs.
    For now the option is offered only on Windows; it cannot be switched on
    where the MXC probe failed, only off.
  - **Ordinary chats leave MXC.** MXC now wraps only a secure project's
    commands. Every other chat's command runs on the host on Windows too,
    gated by its approval mode, as on macOS and Linux; the user's Desktop,
    Documents and Downloads are no longer MXC grants, only paths named to the
    model. The session's MXC probe stays: it decides whether a secure project
    can be switched on.
  - **MCP servers** are host processes MXC cannot wrap, so in a secure
    project they are off unless ticked in the project's list
    (`allowedMcpServers`, by `mcp_config.json` key). The chat offers only the
    ticked servers' tools, and `call_tool` takes the calling `threadId` and
    refuses any other server for that thread (bundled web search included),
    because chat routes a tool call by name across every connected server.
  - **Chat side.** In a secure thread the `run_command` / `run_script`
    descriptions name the project's folders instead of the user's, are not
    offered at all without MXC, web search servers are muted when the
    internet is off, and the approval dialog names the folders. Deleting a
    project deletes its policy.
- **Consequences:** On Windows an ordinary chat's approved command can now
  read and change anything the user can, as on the other OSes; the approval
  dialog says it runs with the user's permissions. The folder guarantee
  covers commands and scripts. A
  ticked MCP server keeps its own full access — the dialog says so — and a
  renamed server drops off the list (fail closed). The allowlist check in
  `call_tool` relies on the chat passing `threadId`; a call made outside a
  chat's tool loop passes none and is not restricted. Attachments the user
  adds and RAG documents are unaffected (the user chose them). MXC
  1.0's network rules were not verified by its probe
  (`…-sandbox-chat-commands-with-mxc-on-windows.md`), so "internet off" needs
  a check on a real Windows machine. Moving a thread out of the project, or
  deleting the project with its threads kept, makes them ordinary chats.
  Hidden Agent mode is not covered.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/secure_env/mod.rs`,
  `src-tauri/src/core/chat_exec/commands.rs` (`run_request`,
  `secure_without_sandbox`, `failure_hint`),
  `src-tauri/src/core/chat_exec/mxc.rs` (`build_policy`),
  `web-app/src/hooks/useSecureEnvironments.ts`,
  `web-app/src/containers/dialogs/SecureEnvironmentFields.tsx`,
  `web-app/src/containers/dialogs/AddProjectDialog.tsx`,
  `web-app/src/lib/chat-exec-tools.ts`, `web-app/src/lib/custom-chat-transport.ts`,
  `web-app/src/containers/dialogs/ToolApproval.tsx`,
  `src-tauri/src/core/mcp/commands.rs` (`call_tool`),
  `web-app/src/lib/execute-chat-tool-calls.ts`.

<!--
Supersedes: 2026-10-15-sandbox-chat-commands-with-mxc-on-windows.md (MXC around every chat command; the executor, tier and probe stand)
Supersedes: 2026-10-15-let-chat-commands-reach-the-users-own-folders.md (only the "Windows sandbox" grant of the three folders)
Supersedes: 2026-10-15-fix-windows-chat-directory-enumeration-and-output.md (the ancestor enumeration grants; the output decoding stands)
-->
