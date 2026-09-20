---
date: 2026-09-19
title: "secret-service uses the pure-Rust crypto backend, on the tokio runtime"
---

# 2026-09-19 — `secret-service` uses the pure-Rust crypto backend, on the tokio runtime

- **Context:** `zbus-secret-service-keyring-store` pulls in `secret-service`, which
  ships no `default` feature and refuses to compile until one cryptography backend is
  chosen: `compile_error!("Please enable a cryptography feature (crypto-rust or
  crypto-openssl)")`. Until this was picked, Radium could not build on Linux at all —
  `make verify` died at `clippy-rust`, and `Radium CI` had never gone green. The two
  backends are alternatives, not layers: `crypto-openssl = [dep:openssl]`,
  `crypto-rust = [dep:aes, dep:cbc, dep:sha2, dep:hkdf]`.

- **Decision:** enable `rt-tokio-crypto-rust` on
  `zbus-secret-service-keyring-store` — the pure-Rust backend, on the tokio runtime.
  The `rt-tokio-` half matches the runtime this crate already selects for `zbus`;
  without it `secret-service` would pull `async-io` in alongside tokio. Sixteen
  RustCrypto and support package versions enter the lockfile (`aes`, `block-buffer`,
  `block-padding`, `cbc`, `cipher`, `cmov`, `const-oid`, `cpubits`, `cpufeatures`,
  `crypto-common`, `ctutils`, `digest`, `hkdf`, `hmac`, `inout`, `sha2`), approved by
  the user under AGENTS.md rule 6; only `cbc` is a new crate name, the rest are
  current-generation versions of crates already present.

- **Consequences:** the Linux build works, and the credential path is pure Rust, so
  RustCrypto's timing-side-channel posture applies to it rather than OpenSSL's. The
  cost is sixteen more crates to keep patched. `aes` is pinned to 0.9.2: 0.9.3
  declares `rust-version = "1.89"` and this crate promises 1.88, so Cargo refuses it
  on the stated MSRV — CI never catches that, because the workflow installs latest
  stable.

- **On the rejected alternative — and two corrections.** `crypto-openssl` was rejected
  for reasons that were both **wrong**, and the record should say so rather than
  flatter the decision:

  1. First claim: it would make OpenSSL a *new build requirement*. Wrong —
     `radium-ci.yml` already installs `libssl-dev`.
  2. Second claim: it would link a *host system* crypto library. Also wrong. `reqwest`
     is declared with `native-tls-vendored` under
     `cfg(not(any(target_os = "android", target_os = "ios")))`, which includes desktop
     Linux, and `openssl-src` is already in the lockfile. Cargo feature unification
     means `crypto-openssl` would have reused that vendored static build and linked no
     host library either. Found by a review bot on PR #31, after this record was first
     written.

  So the honest comparison is: `crypto-openssl` adds approximately no new crates and
  routes credential encryption through the C OpenSSL already compiled into the binary;
  `crypto-rust` adds sixteen package versions and keeps that path in Rust. On "fewest
  new dependencies" — the spirit of rule 6 — `crypto-openssl` is the better-argued
  option. `crypto-rust` stands because it is what the user approved and because a
  pure-Rust credential path is a defensible security default in itself, **not**
  because it avoids a system dependency that `crypto-openssl` would have added. If
  that trade is revisited, switching is one word in `Cargo.toml`. Enabling both
  features at once is possible in Cargo terms and pointless in practice.

- **Owner:** `team`.

- **Links:** PR — https://github.com/walladanger/Radium/pull/31;
  `src-tauri/Cargo.toml` (the `cfg(target_os = "linux")` dependencies);
  prior record on the credential store —
  [`2026-09-10-store-media-provider-credentials-in-the-os-credential-store.md`](2026-09-10-store-media-provider-credentials-in-the-os-credential-store.md).
