---
date: 2026-09-17
title: "Expose the Local API Server through a bundled Cloudflare quick tunnel and on the LAN"
---

# 2026-09-17 — Expose the Local API Server through a bundled Cloudflare quick tunnel and on the LAN

- **Context:** People want to use the models running on one machine from
  another: a second Atomic Chat (desktop or mobile), an SDK, a coding agent.
  Until now the only path was "bind `0.0.0.0`, find your own IP, type it into
  Trusted Hosts, and have no answer at all for a client outside the network" —
  and the Trusted Hosts step alone produced a recurring support thread (see the
  2026-06-09 record). Unsloth Studio ships the shape users ask for: a
  "Remote & LAN" page where *Remote access* opens a free Cloudflare quick tunnel
  (`https://<words>.trycloudflare.com`, no account, no domain) and *LAN access*
  puts the server on the local network. Their implementation is AGPL-3.0, so
  this mirrors the behaviour and copies no code.

  Four things in our codebase made a naive port impossible:

  1. `is_valid_host` answers **403** to `Host: <random>.trycloudflare.com` and
     to `Host: 192.168.x.y:1337`. `trusted_hosts` is snapshotted into
     `ProxyConfig` at bind time, while a quick tunnel's name is only known
     seconds *after* `cloudflared` starts and is new on every start.
  2. The Local API Server has **no lifecycle events**; the frontend polls
     `get_server_status` on window focus. A tunnel URL arrives asynchronously.
  3. The sidecar pipeline (`scripts/download-bin.mjs`) takes `releases/latest`
     with **no checksum**, and on macOS copies the arm64 binary under the
     `-universal-apple-darwin` name. Acceptable for `bun`/`uv`; not for the one
     binary that opens public ingress to the user's machine.
  4. `process_reaper` finds orphans by *name + install directory*, which cannot
     work for an `externalBin` (it sits next to the executable, not under the
     resource dir; an AppImage's mount path changes per launch) and would kill
     a user's own `cloudflared`.

- **Decision:**
  1. **`cloudflared` is a bundled `externalBin` sidecar**, not a runtime
     download. It is the first pinned and checksummed sidecar: version, size and
     hashes of every asset live as constants in `scripts/download-bin.mjs`, and
     a mismatch fails the build. The macOS assets carry **two independent
     pins**, because the two published checksums describe different bytes: the
     `.tgz` archive is checked against the digest GitHub reports for the release
     asset, and the executable inside it against the checksum in Cloudflare's
     release notes (which is *not* the archive's hash). After a verified install
     a stamp (version + sha256 of each installed file) lets later runs skip the
     network entirely, while a missing, truncated or placeholder file, or a new
     pin, reinstalls from the re-hashed `scripts/dist` cache or downloads again.
     `make download-cloudflared` runs just this step; `yarn download:bin`, the
     first step of every dev target and of the release jobs, includes it. macOS
     gets a **real `lipo`** of the two verified slices. macOS signing is the
     Tauri bundler's (our Developer ID, hardened runtime, existing notarization).
     **Windows keeps Cloudflare's own Authenticode signature**: CI only verifies
     `Status = Valid` and the publisher, because their certificate is the one
     SmartScreen and antivirus engines already know. It is always launched with
     `--no-autoupdate` (self-update would break the bundle signature), with
     inherited `TUNNEL_*` variables removed, and with `--config` pointed at an
     empty document: cloudflared otherwise reads the user's own
     `~/.cloudflared/config.yml`, and a named tunnel's ingress rules there make
     it answer 404 to every request through the quick tunnel.
  2. **Dynamic trusted hosts, without touching `is_valid_host`.** A shared
     `DynamicTrustedHosts` carries the live tunnel's hostname; the proxy's
     per-connection closure also knows the *local address of the accepted
     socket*. Per request one extra group `[tunnel host, socket address]` is
     appended to `ProxyConfig::trusted_hosts` (already a `Vec<Vec<String>>`), so
     every existing call site, the CORS origin check included, picks it up
     unchanged. This is the mechanism the 2026-06-09 record deferred, and it
     does not weaken the DNS-rebinding guard: a rebinding attack puts the
     *attacker's* domain in `Host`, never the tunnel's real public name nor the
     literal address of the socket. Trusting the socket address (rather than an
     enumerated interface list) stays correct across sleep/wake, Wi-Fi switches
     and DHCP changes, and makes LAN access work with zero Trusted Hosts input.
  3. **A tunnel manager with one supervisor task per run**
     (`src-tauri/src/core/server/remote_access/`). The URL is shown only after
     (a) cloudflared printed it *and* "Registered tunnel connection", with one
     retry over `--protocol http2` when a URL appeared but never registered
     (networks that drop QUIC/UDP; both transports use port 7844), and
     (b) a **public probe** fetched `GET /openapi.json` through the tunnel and
     found our own `info.title` — first through Cloudflare's edge by SNI
     (`reqwest`'s `resolve`), which works before DNS propagates and cannot
     poison the OS negative cache, then by hostname, inside one 45 s budget.
     A Cloudflare 1033 page is an answer but not ours. Exit is detected by
     `child.wait()`, never by pipe EOF. Stop is SIGTERM → 5 s → kill → 5 s; an
     unconfirmed exit becomes `stop_failed`, which offers only Stop.
  4. **`remote-access:status` is the area's first lifecycle event**, emitted
     through a type-erased sink like `RequestInspector`'s (`AppState` is not
     generic over the runtime). `stop_server` takes the tunnel down *first*,
     `RunEvent::Exit` kills it synchronously before the hook's early return, and
     so does `restart_app` (relaunch and factory reset skip `RunEvent::Exit`,
     and a factory reset deletes the pid journal that would otherwise recover it).
  5. **Crash recovery by pid journal**, like the agent PTY children
     (`<data>/remote-access-tunnel.json`: pid + start time + name check), plus
     `PR_SET_PDEATHSIG` on Linux. No entry in `process_reaper`.
  6. **LAN access is a rebind, not a second listener**: the page flips the
     existing `serverHost` to `0.0.0.0` and restarts the proxy (start is
     idempotent, so a host change must go stop → start). Models stay loaded.
     `get_lan_addresses` (already-vendored `sysinfo`, no new crate) is for
     display only and hides virtual adapters.
  7. **The API key stays optional** (product decision by the user). Rust never
     refuses for a missing key; the frontend makes the choice explicit with a
     confirm dialog on Remote access and a warning on both cards, and offers a
     one-click generated key.
  8. Desktop only (`PlatformFeature.LOCAL_API_SERVER`); the four commands are
     in the desktop handler block and in `EXPECTED_DESKTOP_ONLY`. One new npm
     dependency, `react-qr-code`, approved by the user; no new Rust crates.

- **Consequences:**
  - **An existing checkout needs the sidecar once after pulling this**:
    `tauri-build` validates `externalBin` paths, so a bare `yarn dev` fails
    until it exists. `make dev` and the other dev targets fetch it by themselves
    (their first step is `yarn download:bin`); anyone who starts `yarn dev`
    directly runs `make download-cloudflared` once (~40 MB on macOS, where both
    slices are needed for the universal binary). The installer grows by ~20 MB
    on Windows and Linux and ~40 MB on macOS.
  - Updating cloudflared is a deliberate edit of one constant block; nothing
    auto-updates. Re-check the Windows publisher match when Cloudflare rotates
    its certificate.
  - Quick tunnels are for temporary use: the URL changes on every start (a
    saved client breaks after a restart; the auto-start copy says so), there is
    no SLA, roughly 200 concurrent requests, and only POST-SSE streams work,
    which is what our chat completions use. A network that blocks port 7844
    entirely ends in `not_registered`; one that blocks
    `api.trycloudflare.com` in `no_url`.
  - Through a tunnel the Swagger page (`/`) and `/openapi.json` are readable
    without an API key, as they are locally. With no key set, so is everything.
  - `stop_server` can now take up to ~10 s in the worst case (a cloudflared
    that ignores SIGTERM and SIGKILL); normally it is milliseconds.
  - Some antivirus engines flag tunnelling tools; keeping Cloudflare's
    signature is the mitigation. Check the pinned binary and the built installer
    on VirusTotal before a release.
  - Not done, on purpose: DGX Spark / `atomic-chat-cli serve --host/--tunnel`
    and QR pairing with a token; named tunnels on the user's own domain (a
    stable address); serving the web UI through the tunnel; pinning `bun`/`uv`.

- **Owner:** team.

- **Links:**
  [`src-tauri/src/core/server/remote_access/`](../../src-tauri/src/core/server/remote_access/),
  [`src-tauri/src/core/server/dynamic_hosts.rs`](../../src-tauri/src/core/server/dynamic_hosts.rs),
  [`src-tauri/src/core/server/proxy.rs`](../../src-tauri/src/core/server/proxy.rs) (per-connection closure),
  [`src-tauri/src/core/server/commands.rs`](../../src-tauri/src/core/server/commands.rs),
  [`scripts/download-bin.mjs`](../../scripts/download-bin.mjs),
  [`.github/workflows/release.yml`](../../.github/workflows/release.yml),
  [`web-app/src/routes/settings/remote-lan.tsx`](../../web-app/src/routes/settings/remote-lan.tsx),
  earlier records
  [2026-06-09 Host header](2026-06-09-make-the-local-api-server-invalid-host-header-rejection.md)
  and
  [2026-09-11 idempotent start](2026-09-11-make-starting-the-local-api-server-idempotent.md);
  external:
  [Cloudflare quick tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/),
  [tunnel firewall requirements (port 7844)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).
