---
date: 2026-10-10
title: 'Give the agent network tools behind a tool pack, with blast-radius approvals'
---

# 2026-10-10 — Give the agent network tools behind a tool pack, with blast-radius approvals

- **Context:** Users want the agent to diagnose *and fix* network problems. The agent could already run arbitrary shell commands, but the model would have to improvise OS-specific commands. Those are easy to get wrong across Windows, macOS and Linux, and their approval card shows only a raw command line. Adding many tools to every turn would also bloat every prompt.
- **Decision:**
  - **Fifteen `net.*` tools** in `src-tauri/src/core/agent/tools/net/`:
    - nine diagnose tools (`PureRead`): `system_map`, `connectivity`, `interfaces`, `wifi_status`, `dns_lookup`, `ping`, `traceroute`, `neighbors`, `port_check`;
    - six fix tools (`ApprovalGated`): `dns_flush`, `dhcp_renew`, `adapter_restart`, `set_dns`, `wifi_reconnect`, `stack_reset`.
  - **Fixed commands.** Every command is fixed per OS in `platform.rs`; the model chooses only the tool and validated arguments.
  - **Input validation.**
    - Hosts must be names or IPs and can never start with `-`.
    - DNS servers must be IPs.
    - Adapter names must match a live adapter exactly.
    - Port checks only reach private, loopback or link-local addresses.
  - **No injection.** Values reach PowerShell as single-quoted literals and reach Unix tools as separate argv entries.
  - **Elevation.** A fix that fails for lack of rights is retried behind the OS's own admin prompt (UAC via `Start-Process -Verb RunAs`, macOS `osascript … with administrator privileges`, Linux `pkexec`). A declined prompt changes nothing.
  - **Blast radius.** Every fix's approval preview carries a `blastRadius`, rendered on the card itself:
    - the action, what changes, what drops and for how long, and who is affected;
    - how to undo it;
    - whether it needs admin rights or a reboot;
    - a risk level.
  - **Before and after.** Fixes report before/after state (for example, the previous DNS servers for undo) and re-check the result.
  - **Second opinion.** Before a fix's approval card appears, a **separate reviewer call** (`tools/net/review.rs`) reads:
    - a fresh `net.system_map`;
    - the proposed call;
    - the agent's optional `reason` argument;
    - the blast radius.

    It answers `agree`, `concern` or `disagree` with a short explanation. The answer is constrained by GBNF on llama.cpp and a JSON schema on chat transports. The verdict and the agent's reason are shown on the card. The reviewer advises and never blocks: an unavailable review says so, and the user still decides.
  - **Tool packs.** The tools belong to the `network` **tool pack**. They are disabled in the prompt, grammar, schema and dispatch unless the turn's assistant (or a specialist) has `tool_packs: ["network"]`. Each specialist gets its own disabled set.
  - **Template.** A "Network" specialist template in the assistant editor sets this up in one click.
  - **No new dependencies.** Commands use OS built-ins; DNS timing, port checks and TCP reachability use std/tokio.
- **Consequences:**
  - **Windows verified.** All diagnose paths were run live on Windows 11 by ignored `live_tests`.
  - **macOS and Linux not verified.** Their commands and parsers are covered by fixture tests in each platform's real format, but have not run on real hardware.
  - **Language.** Windows output is read from PowerShell JSON wherever possible, so it doesn't depend on the system language. `netsh wlan` is the exception (English labels); a non-English system falls back to the raw text.
  - **Raw fallback.** When a parser does not recognise output, the raw output is shown to the model rather than guessed.
  - **Last resort.** `stack_reset` is Windows-only, high risk and needs a reboot. The template's instructions treat it as a last resort.
- **Owner:** @walladanger.
- **Links:** `tools/net/{mod,platform,run,parse,diagnose,fix}.rs`; `web-app/src/containers/ApprovalBlastRadius.tsx`; `web-app/src/lib/assistant-templates.ts`; ADR 2026-10-10 (specialists).
