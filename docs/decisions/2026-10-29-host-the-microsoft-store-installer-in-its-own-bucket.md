---
date: 2026-10-29
title: 'Host the Microsoft Store installer in its own bucket'
---

# 2026-10-29 — Host the Microsoft Store installer in its own bucket

- **Context:** Partner Center refuses a GitHub release asset as the package URL of an "EXE or MSI app":
  "The package URL redirects to another URL. Provide a download URL without redirection." The Store does
  not keep the installer for us. It downloads it from that URL on every install, so the URL must stay up
  and keep the same bytes while a submission points at it. A new Store version means a new submission
  with a new, versioned URL. The `atomic-chat-packages` bucket cannot hold the installer, because
  `linux-repo.mjs sync` deletes every key that is not part of the apt/dnf repository.
- **Decision:**
  - The new `atomic-chat-downloads` bucket on Hetzner Object Storage (Falkenstein, same project) hosts
    the installer. The bucket is private; each installer object is public-read.
  - The new `.github/workflows/msstore.yml` runs on `release: published` (`make release-prod`) or by hand.
    - It copies `Atomic.Chat_<version>_x64_msstore.exe` from the release to
      `msstore/<version>/Atomic.Chat_<version>_x64_msstore.exe`.
    - It stores the installer's sha256 in the object metadata.
    - It never replaces an object that holds other bytes.
    - It checks that the public URL serves the same sha256 with a 200 and no redirect.
    - It writes that URL to the run summary for Partner Center.
  - It uses the `packages` environment and its `PACKAGES_S3_*` credentials, which are project-wide.
- **Consequences:**
  - Store submissions get a direct, immutable URL per published version.
  - Drafts and pre-releases are skipped, and nothing is deleted. That costs about 400 MB per published
    release.
  - Not every release has to go to the Store: installs from the Store keep the in-app updater. A Store
    submission only decides what new users get first.
  - A tag created before this workflow existed (v2.2.29, v2.3.0) carries no `msstore.yml`. Its publish
    event cannot start it, so run it by hand from a later `v*` tag with `-f tag=vX.Y.Z`.
- **Owner:** team.
- **Links:** `.github/workflows/msstore.yml`,
  `docs/decisions/2026-10-22-sign-every-windows-pe-via-tauri-signcommand-and-ship-an-msstore-installer.md`
  (its Hosting note),
  [Upload app packages for MSI/EXE app](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/upload-app-packages).
