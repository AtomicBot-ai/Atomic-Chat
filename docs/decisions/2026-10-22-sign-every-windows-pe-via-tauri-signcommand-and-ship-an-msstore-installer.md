---
date: 2026-10-22
title: "Sign every Windows PE file through Tauri's signCommand and ship a Microsoft Store installer"
---

# 2026-10-22 — Sign every Windows PE file through Tauri's signCommand and ship a Microsoft Store installer

- **Context:** We are publishing Atomic Chat to the Microsoft Store as an "EXE or MSI app".
  Store policy 10.2.9 asks for three things the x64 release did not deliver:
  - "The binary and all of its Portable Executable (PE) files must be digitally signed."
  - The installer must be a standalone, offline installer, not a downloader.
  - Silent install, an Add/Remove Programs entry, and a clean uninstall.

  Signing today:
  - No Tauri config set `signCommand`, so `tauri build` signed nothing.
  - CI signed the outer `nsis/*.exe` and `.msi` after bundling, too late to reach the files inside.
  - Already signed before bundling: the core pair (and the `jan-cli` copy), the mirrored llama.cpp
    trees (2026-08-13), TurboQuant, `cloudflared` (Cloudflare) and `wxc-exec` (Microsoft).
  - Unsigned inside both installers: `Atomic-Chat.exe`, the NSIS uninstaller and plugins, `bun.exe`
    and `uv.exe`.

  WebView2 came in through `downloadBootstrapper`, which fetches the runtime at install time.
- **Decision:**
  - **`build-windows` passes `bundle.windows.signCommand`** to `tauri build` as a CI-only `--config`
    file (`$RUNNER_TEMP/tauri-sign.conf.json`). It carries the same `signtool /sha1 … /fd SHA256 /tr
    http://timestamp.digicert.com /td SHA256` call the installers used before.
    - With it, tauri-cli 2.8.4 signs on an x64 host: the app binary, the sidecars, every unsigned
      `.exe`/`.dll` under `resources`, five NSIS plugins, the uninstaller (`!uninstfinalize`), the
      installer and the MSI.
    - Files that already verify are skipped, so vendor signatures stay.
    - The post-build signing step is removed; it would only re-sign the installers.
    - Local builds keep no `signCommand`, so they stay unsigned and need no signtool.
  - **The Store gets its own installer.**
    - `tauri bundle --bundles nsis` re-packs the built binary with
      `src-tauri/tauri.windows.msstore.conf.json` (`webviewInstallMode: offlineInstaller`, no updater
      artifacts) and the same signing config.
    - It is uploaded as `Atomic.Chat_<version>_x64_msstore.exe`, on every tag push and on dispatch
      when `build_windows_msstore` is ticked.
    - The name has no `-setup`, so `upload-windows` and `latest.json` keep picking the regular
      installer. The website and the updater keep the small download-bootstrapper installer.
  - **A CI gate unpacks the NSIS installers with 7-Zip.**
    - It fails on an installer not signed by AtomicMail Systems OU, or on any unsigned `.exe`/`.dll`
      that would be installed.
    - It checks that the Store installer embeds the WebView2 runtime installer.
    - `$PLUGINSDIR` DLLs only warn: they are unpacked to `%TEMP%` for the duration of the install and
      never installed. Tauri does not sign `nsExec.dll`, which `windows/hooks.nsh` uses.
  - **`scripts/verify-windows-installer.ps1` checks a real install by hand** (on a clean standard
    user, locally or over SSH):
    - signature and silent install;
    - the Add/Remove Programs metadata and the Start Menu shortcut;
    - every installed PE, including `uninstall.exe`;
    - WebView2, launch, silent uninstall and leftovers.
- **Consequences:**
  - The x64 installers ship fully signed, which the Store requires and SmartScreen rewards.
  - About 25 KeyLocker signatures per x64 tag instead of ~4 (the app binary once per package type,
    two sidecars, five plugins, uninstaller, installer, MSI and its WiX DLLs, then the Store bundle
    again). Check this against the DigiCert plan's signature allowance.
  - The x64 job grows by the signing calls, the ~180 MB WebView2 offline installer download and a
    second LZMA pack, roughly 5–8 min, still under its 75 min ceiling.
  - Out of scope:
    - **ARM64 stays as it was.** tauri-cli 2.8.4 cannot find signtool on an arm64 host, the DigiCert
      KSP is x64-only, and `offlineInstaller` has no ARM64 WebView2 link (it embeds the x86 one). The
      way forward is cross-compiling `aarch64-pc-windows-msvc` on an x64 runner with the same
      `signCommand`.
    - **`bundle.publisher` is unchanged.** It names the NSIS registry key
      `Software\<publisher>\Atomic Chat` that finds the previous install folder.
    - **Hosting.** The Store needs an immutable, versioned HTTPS URL, ideally on our own CDN; until
      then the GitHub release asset is the source.
- **Owner:** team
- **Links:** `.github/workflows/release.yml`, `src-tauri/tauri.windows.msstore.conf.json`,
  `scripts/verify-windows-installer.ps1`, `src-tauri/windows/hooks.nsh`,
  [Store policy 10.2.9](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies),
  [Tauri: Microsoft Store](https://v2.tauri.app/distribute/microsoft-store/),
  `docs/decisions/2026-08-13-mirror-and-sign-upstream-llama-cpp-in-atomic-chat-conf.md`
