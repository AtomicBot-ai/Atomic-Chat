---
date: 2026-06-09
title: "Make the Local API Server \"Invalid host header\" rejection actionable + fix Trusted Hosts field copy (ATO-118, scope I+II)"
---

# 2026-06-09 — Make the Local API Server "Invalid host header" rejection actionable + fix Trusted Hosts field copy (ATO-118, scope I+II)

- **Context:** LAN users cannot reach the local API server (`:1337`) from
  another machine — they get `403 Invalid host header` even with `host=0.0.0.0`
  and Trusted Hosts filled in. Recurring (Discord; upstream
  [janhq/jan#7345](https://github.com/janhq/jan/issues/7345), maintainer's
  official answer is `*`). The check `is_valid_host`
  ([`src-tauri/utils/src/http.rs:19`](src-tauri/utils/src/http.rs)) is
  **correct** — a security feature inherited verbatim from Jan — but the UX
  misleads users into two systematic mistakes: (1) entering the **client**
  (source) IP, when the `Host` header carries the **destination** (server)
  address, so there is nothing to match; (2) entering wildcard patterns
  (`10.*.*.*`), which are compared as literal strings — only the literal `*`
  short-circuits to allow-all. The 403 body was the opaque string
  `"Invalid host header"` (main branch, `proxy.rs:1740`) /`"Host not allowed"`
  (CORS-preflight branch, `proxy.rs:1611`); both are read by the **external
  LAN client** (curl / third-party app), not our own UI.
- **Decision:** Ship the low-risk core only (ticket's items 1+2); **do not**
  touch the security-validation logic. The stretch CIDR/`*`-wildcard support
  in `is_valid_host` (ticket item 3) was deliberately deferred.
  1. **Actionable error (`proxy.rs`).** Both rejection branches now return a
     host-naming hint: `Host '<host>' is not in Trusted Hosts. Add this
     server's address (e.g. its LAN IP or hostname) in Settings → Local API
     Server → Trusted Hosts, or use '*' to allow all.` (interpolating
     `host_header` / `host` respectively). No status-code or routing change.
  2. **Field copy (EN only).** `trustedHostsDesc`
     (`web-app/src/locales/en/settings.json`) rewritten to state it is the
     **server's** own address (LAN IP / hostname, with inline example
     `192.168.1.100, my-host`), **not** the connecting client's, that `*`
     allows all, and that wildcard/CIDR patterns are unsupported. The
     placeholder `enterTrustedHosts`
     (`web-app/src/locales/en/common.json`, sole consumer
     `TrustedHostsInput.tsx`) now reads `This server's address, e.g.
     192.168.1.100, my-host (or * for all)`. Other locales fall back to EN.
- **Consequences:** The 403 now tells the LAN debugger exactly what to do; the
  Settings field stops inviting the client-IP mistake. No behaviour change to
  who is actually allowed — `is_valid_host` is byte-for-byte unchanged, so the
  inherited security posture is preserved. `cargo check -p Atomic-Chat` passes
  (0 errors; pre-existing unrelated `dead_code` warnings only); the two EN JSON
  scrolls lint clean. **Not done (deferred):** CIDR / `10.*.*.*` matching in
  `is_valid_host`, unit tests for that function (still uncovered), and any
  non-EN locale copy.
- **Owner:** team.
- **Links:** [ATO-118](https://linear.app/atomicchat/issue/ATO-118),
  [janhq/jan#7345](https://github.com/janhq/jan/issues/7345), §5 *Local API*,
  files: [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs)
  (host-rejection branches),
  [`web-app/src/locales/en/settings.json`](web-app/src/locales/en/settings.json)
  (`trustedHostsDesc`),
  [`web-app/src/locales/en/common.json`](web-app/src/locales/en/common.json)
  (`enterTrustedHosts`).
