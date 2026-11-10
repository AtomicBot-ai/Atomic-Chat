# Sign the Windows ARM64 build on the arm64 runner

- **Date:** 2026-11-10
- **Status:** Accepted
- **Amends:** [Sign Windows builds with Azure Key Vault](2026-11-10-sign-windows-builds-with-azure-key-vault.md)

## Context

The Windows ARM64 release was signed on x64 runners: `sign-windows-arm64-core` signed the core pair
before the build and `sign-windows-arm64-installer` signed only the finished `*-setup.exe` after it.
That split came from DigiCert KeyLocker, whose KSP was x64-only. Everything inside the ARM64
installer (Atomic-Chat.exe, the bun/uv sidecars, unsigned resources, NSIS plugins, the uninstaller)
shipped unsigned, which Smart App Control blocks on Windows on Arm PCs and which the Microsoft Store
policy 10.2.9 does not accept.

Signing now goes through AzureSignTool against Azure Key Vault, a .NET tool that runs on arm64.
tauri-bundler 2.x could not sign inside an arm64 build only because its own signtool lookup
(registry + OS bitness) finds nothing there; it reads `TAURI_WINDOWS_SIGNTOOL_PATH` first.

## Decision

`build-windows-arm64` signs like `build-windows`: it runs in the `codesign` environment, installs
.NET and AzureSignTool, points `TAURI_WINDOWS_SIGNTOOL_PATH` at the SDK's signtool, checks access to
the certificate early, signs the core pair with `src-tauri/sign.ps1` and passes the same
`signCommand` to `tauri build`. It then recreates the updater signature, checks that every PE inside
the installer is validly signed (the same check as x64), and uploads the installer to the draft
itself. `sign-windows-arm64-core` and `sign-windows-arm64-installer` are removed; `publish-latest-json`
and `notify-finish` read `build-windows-arm64`.

## Consequences

- Every PE in the ARM64 installer carries the AtomicMail Systems OU signature; a missing one fails
  the build.
- Two x64 jobs and two artifact hand-offs are gone from the ARM64 path.
- If tauri-bundler changes its signtool lookup, `TAURI_WINDOWS_SIGNTOOL_PATH` is the place to look.
