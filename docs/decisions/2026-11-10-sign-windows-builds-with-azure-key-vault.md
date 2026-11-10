---
date: 2026-11-10
title: 'Sign Windows builds with the Azure Key Vault key through GitHub OIDC'
---

# 2026-11-10 — Sign Windows builds with the Azure Key Vault key through GitHub OIDC

- **Context:** Release builds signed every Windows PE file with DigiCert KeyLocker: `smctl` and its KSP,
  `smctl windows certsync`, `signtool sign /sha1 <fingerprint>`, and three stored secrets (`SM_API_KEY`,
  `SM_CLIENT_CERT_FILE_B64`, `SM_CLIENT_CERT_PASSWORD`). KeyLocker counts every signature against the
  plan's allowance (about 25 per x64 tag since every PE is signed, 2026-10-22), and its x64-only KSP
  pinned `build-windows` to `windows-2022` and kept signing off arm64 hosts. The same certificate
  (`CN=AtomicMail Systems OU`) now lives in the `atomic-codesign` Key Vault as `atomicmail-codesign`, with
  a non-exportable RSA-HSM key, and `atomic-chat-conf` already signs its llama.cpp mirrors from there.
- **Decision:**
  - Every Windows signing step uses AzureSignTool 7.0.1 against that certificate: SHA-256 file digest,
    RFC 3161 timestamp from `timestamp.digicert.com`, `signtool verify /pa` after each file. Which files
    get signed, the skip of files that already verify, and the signature reports are unchanged.
  - Jobs sign in to Azure by GitHub OIDC, with no stored secret. The Entra app's federated credential
    trusts `repo:AtomicBot-ai/Atomic-Chat:environment:codesign`, so each signing job runs in the
    `codesign` environment (its variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_KEY_VAULT`,
    `AZURE_CODESIGN_CERT`) with job-level `id-token: write` on top of what it already needed.
  - `build-windows` signs through `src-tauri/sign.ps1`, now Tauri's `signCommand`
    (`pwsh -File <abs path>/sign.ps1 %1`) and also used for the core pair before bundling. The bundler
    signs near the end of a ~40 minute build, past what a token fetched up front could outlive (60–90
    minutes, and azure/login cannot renew its OIDC session). So `scripts/ci/get-keyvault-token.ps1`
    exchanges a fresh GitHub ID token for a Key Vault token on demand, without the Azure CLI, and caches
    it in `RUNNER_TEMP` until five minutes before it expires. A step before the build fetches the first
    token, masks it and checks the certificate (enabled, not expired, expected subject).
  - The ARM64 jobs keep signing on x64 runners through `.github/actions/windows-code-sign`, now the same
    as `atomic-chat-conf`'s (azure/login, one `az` token per call, which suits short jobs).
- **Consequences:**
  - No signature quota and no DigiCert tooling download in CI; the `SM_*` secrets are unused and can be
    deleted once a release has signed this way.
  - Anyone who can run a workflow in the `codesign` environment can sign with the company certificate.
    The environment has no branch or reviewer rules today; restricting it to `main` and release tags
    would leave only release runs able to sign.
  - `sign.ps1` fails the bundler on any error. Tauri hides a failing command's output unless verbose, so
    the script also appends to `$RUNNER_TEMP/codesign.log`, which the build step prints on failure.
  - AzureSignTool also runs on arm64, so the ARM64 signing jobs could move onto `windows-11-arm` later;
    tauri-cli 2.8.4 still cannot sign inside an arm64 build (it cannot find signtool there).
- **Owner:** team
- **Links:** `.github/workflows/release.yml`, `.github/actions/windows-code-sign/action.yml`,
  `src-tauri/sign.ps1`, `scripts/ci/get-keyvault-token.ps1`, AtomicBot-ai/atomic-chat-conf
  `.github/actions/windows-code-sign/action.yml`,
  `docs/decisions/2026-10-22-sign-every-windows-pe-via-tauri-signcommand-and-ship-an-msstore-installer.md`,
  [AzureSignTool](https://github.com/vcsjones/AzureSignTool),
  [Workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation).

<!--
Supersedes: the signing tool of 2026-10-22-sign-every-windows-pe-via-tauri-signcommand-and-ship-an-msstore-installer.md
(KeyLocker `signtool /sha1`); what gets signed is unchanged.
-->
