---
date: 2026-10-26
title: 'Ship deb, rpm and AUR packages from the AppImage build'
---

# 2026-10-26 — Ship deb, rpm and AUR packages from the AppImage build

- **Context:** Linux users got only the AppImage, which updates itself and
  lives outside the package manager. The package-managed switch
  (2026-10-21) made a distro package possible but nobody built one. eye-cli
  already ships `atc` as deb, rpm, an apt/dnf repository on Hetzner Object
  Storage and `atc-bin` on the AUR, signed with the "Atomic Chat Packages" key.
  Tauri's own deb/rpm targets were not usable as they are: they install the
  `externalBin` sidecars as `/usr/bin/uv` and `/usr/bin/cloudflared`, which
  collide with the distros' own `uv`/`cloudflared` packages, and they cannot
  carry the Bun-compiled core binaries that buildAppImage.sh adds by hand. The
  AppImage's AppDir is not a package payload either: linuxdeploy patched its
  ELF files' rpaths and bundled GTK/WebKit copies that drift from the system's.
- **Decision:** Package with nfpm, as eye-cli does, from what the AppImage
  jobs already build. `tauri build --bundles appimage,deb`; the Tauri deb is
  only a source: `scripts/linux-packages.mjs stage` moves its binary, sidecars
  and `usr/lib/Atomic Chat` under `/opt/atomic-chat/{bin,lib}` (the layout
  `resource_dir` resolves: `<exe dir>/../lib/<productName>`), adds bun and the
  core binaries, the `atomic-chat-package-managed` marker next to the
  executable, and reads the dependencies from every ELF file of the payload:
  deb `Depends` are the Ubuntu 22.04 packages that own the needed libraries
  (ldconfig + `dpkg -S`, unversioned but `libc6 (>= glibc floor)`), rpm
  `Requires` are sonames with symbol versions as rpmbuild writes them, so
  Fedora and openSUSE resolve them by soname. libayatana-appindicator (dlopened
  by the tray, which panics without it) is added by hand; GStreamer plugins
  and xdg-utils are recommended. `/usr/bin/atomic-chat` is a symlink; the
  desktop entry is `chat.atomic.app.desktop` with
  `StartupWMClass=chat.atomic.app`: both the Wayland app id, so docks and
  bars match the window by file name or by class (2026-10-21's app-id
  record); X11 is not a target. The `linux-packages` job packs both
  architectures, signs the rpms (required on tag pushes), uploads
  `atomic-chat_<version>_<arch>.{deb,rpm}` to the draft; `smoke-linux-packages`
  installs them in Debian 12/13, Ubuntu 22.04/24.04, Fedora and Arch containers
  (ldd of every ELF file, the app alive 20 s under Xvfb, clean removal). After
  a person publishes the release, `linux-repo.yml` rebuilds the repository
  (its own bucket `atomic-chat-packages`, the newest 3 releases, same key as
  eye-cli) and pushes `atomic-chat-bin` (the PKGBUILD unpacks the deb) to the
  AUR.
- **Consequences:** The glibc floor differs by architecture. x86-64 needs
  2.34 (Debian 12+, Ubuntu 22.04+). arm64 needs 2.38: the ELF scan found its
  bundled upstream llama.cpp (`llamacpp-backend-upstream`, ggml-org's prebuilt)
  requiring `GLIBC_2.38` and `GLIBCXX_3.4.32`, while the app, core and sidecars
  need 2.35. So arm64 installs on Debian 13+, Ubuntu 24.04+, and apt refuses it
  on Ubuntu 22.04 / Debian 12 instead of installing an engine that cannot load
  — the same engine the arm64 AppImage ships there today.
  The built-in updater never runs (the marker reaches every check), so the
  package manager is the only updater; but it replaces `/opt` under a running
  app, which the AppImage's immutable mount and its updater (which stops the
  core first) never did. The old app stays in the tray, a relaunch only shows
  its window, and if its core restarts before the app does, the old app starts
  the new core binary and the supervisor refuses it (`CORE_VERSION_MISMATCH`)
  until the app is quit. The deb/rpm postinstall and the AUR `.install` say so
  on upgrade; nothing kills the user's app. After a restart the new app retires
  the old core itself (`replace_previous_owner`), as after an AppImage update.
  Staging failures leave the AppImage release untouched
  (`continue-on-error`); `linux-packages` then fails visibly. Packages use the
  system WebKitGTK, so a distro WebKit regression reaches packaged users and
  not AppImage users. The deb dependency names come from Ubuntu 22.04; t64
  renames provide the old names. RHEL/Rocky are not smoke-tested: the tray
  library is only in EPEL there. Before the first release with packages, the
  repository needs secrets the eye-cli repo already has — `LINUX_PACKAGES_GPG_KEY`,
  `LINUX_PACKAGES_GPG_PASSPHRASE` (repo level, for `linux-packages`), and in a
  `packages` environment limited to `v*` tags, as eye-cli's: those two,
  `PACKAGES_S3_ACCESS_KEY_ID`, `PACKAGES_S3_SECRET_ACCESS_KEY`,
  `AUR_SSH_PRIVATE_KEY` — and the `atomic-chat-packages` bucket must exist.
  The AUR key is eye-cli's: the AUR account that maintains `atc-bin`
  (`biogenic_ooze`) creates `atomic-chat-bin` with its first push. The arch `depends` of the PKGBUILD
  are maintained by hand; the Arch smoke's ldd check catches a missing one.
- **Owner:** `team`
- **Links:** `scripts/linux-packaging.mjs`, `scripts/linux-packages.mjs`,
  `scripts/linux-repo.mjs`, `scripts/smoke-linux-package.sh`, `packaging/`,
  `.github/workflows/release.yml` (`linux-packages`, `smoke-linux-packages`),
  `.github/workflows/linux-repo.yml`; AtomicBot-ai/eye-cli `packaging/`.
