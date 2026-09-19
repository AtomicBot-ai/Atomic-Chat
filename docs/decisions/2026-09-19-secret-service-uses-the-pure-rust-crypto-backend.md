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

- **Consequences:** the Linux build works, and the credential path stays pure Rust —
  no C crypto is linked for it, so the store cannot break on a host OpenSSL upgrade.
  The cost is sixteen more crates to keep patched, and RustCrypto's own timing-side-
  channel posture rather than OpenSSL's. Watch for: `crypto-openssl` remains a viable
  alternative — OpenSSL dev headers are already in `radium-ci.yml`'s apt list, so
  choosing it would not have added a CI build requirement (an earlier claim of mine
  that it would was wrong); the real argument for `crypto-rust` is keeping the
  credential store free of a system-library dependency, not availability. Enabling
  both features at once is possible in Cargo terms and pointless in practice.

- **Owner:** `team`.

- **Links:** PR — https://github.com/walladanger/Radium/pull/31;
  `src-tauri/Cargo.toml` (the `cfg(target_os = "linux")` dependencies);
  prior record on the credential store —
  [`2026-09-10-store-media-provider-credentials-in-the-os-credential-store.md`](2026-09-10-store-media-provider-credentials-in-the-os-credential-store.md).
