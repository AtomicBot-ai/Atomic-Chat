# Signing Atomic Chat (Jan / Tauri) for macOS

Following the [official Tauri approach](https://v2.tauri.app/distribute/sign/macos/): environment variables + `yarn build`. A manual `codesign` over the whole `.app` is not needed — the Tauri CLI does it during the build.

## Prerequisites

1. **Apple Developer Program** ($99/year): [developer.apple.com](https://developer.apple.com/programs/).
2. A **Developer ID Application** certificate in the keychain (not "Apple Distribution", which is for the Mac App Store).

The certificate can only be created at Apple: CSR on a Mac → upload to [Certificates](https://developer.apple.com/account/resources/certificates/list) → download the `.cer` → open it (the key goes into Keychain Access). **The certificate cannot be generated for you from the repository** — your developer account is required.

---

## Step 1: Find the signing identity

```bash
security find-identity -v -p codesigning
```

A line like `Developer ID Application: … (TEAMID)` is the **full name**. If there are several matches, it is safer to use the **SHA-1** from the first column.

---

## Step 2: Signed build (as done in the project)

From the `jan/` repository root:

```bash
# if needed, put the extensions into pre-install (copied into the bundle)
cp src-tauri/resources/pre-install/*.tgz pre-install/ 2>/dev/null || true

export APPLE_SIGNING_IDENTITY="Developer ID Application: SpaceshipIntelligence OU (UT6WGPGTGR)"
# or: export APPLE_SIGNING_IDENTITY="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"

CI=false yarn build
```

`CI=false` is required: otherwise Tauri in CI mode may **not** sign.

The finished **universal** DMG (Intel + Apple Silicon):

`src-tauri/target/universal-apple-darwin/release/bundle/dmg/Atomic Chat_*.dmg`

(the name comes from `productName` in `tauri.conf.json`.)

Verify the app signature:

```bash
codesign -dv --verbose=2 "src-tauri/target/universal-apple-darwin/release/bundle/macos/Atomic Chat.app" 2>&1 | grep -E "Authority|Timestamp|runtime"
```

You should see the chain **Developer ID** → **Developer ID Certification Authority** → **Apple Root CA**, a **Timestamp**, and **flags** with runtime on the main binary (Tauri sets Hardened Runtime when signing).

Before the bundle phase, `src-tauri/scripts/strip-macos-xattrs.sh` runs (strips `xattr`); otherwise `codesign` sometimes fails with `resource fork, Finder information, or similar detritus not allowed`.

Tauri signs only `Contents/MacOS/*`. The CLI copies from `bundle.resources` land in `Contents/Resources/resources/bin/` **without** being re-signed, which makes notarytool reject the archive. The `src-tauri/scripts/sign-macos-resource-binaries.sh` script (in the `beforeBundleCommand` chain) signs `jan-cli`, `mlx-server`, `foundation-models-server` in `resources/bin/` before they are copied into the bundle — when `APPLE_SIGNING_IDENTITY` is set.

---

## Optional: notarization

Without notarization, users who download the DMG from Telegram or a browser will see **"Apple could not verify … free of malware"** (quarantine + Gatekeeper).

A ready-made flow from the `jan/` root (checks the variables and calls `yarn build`):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: …"
export APPLE_ID="your@email.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="UT6WGPGTGR"
yarn build:macos:notarized
```

Script: `scripts/macos-build-signed-notarized.sh`. Alternative — API keys: `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` (see [Tauri — Notarization](https://v2.tauri.app/distribute/sign/macos/)).

---

Apple credentials required:

- **APPLE_ID** — the developer's Apple ID email.
- **APPLE_PASSWORD** — an [app-specific password](https://appleid.apple.com/account/manage) (not the regular Apple ID password).
- **APPLE_TEAM_ID** — Team ID (10 characters, shown in the certificate and on developer.apple.com).

```bash
export APPLE_SIGNING_IDENTITY="…"
export APPLE_ID="your@email.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="UT6WGPGTGR"
CI=false yarn build
```

Tauri submits the build for notarization after building (see the Tauri docs). Alternatively, after the build run manually: `xcrun notarytool submit … --wait` and `xcrun stapler staple` for the DMG — see [notarytool](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution).

---

## Native build for the current Mac only (faster, not universal)

For local testing without the Intel slice:

```bash
CI=false APPLE_SIGNING_IDENTITY="…" yarn build:web && yarn build:icon && yarn copy:assets:tauri && CI=false APPLE_SIGNING_IDENTITY="…" yarn build:tauri:darwin:native
```

DMG: `src-tauri/target/release/bundle/dmg/Atomic Chat_*_aarch64.dmg` (on Apple Silicon).

---

## Without an Apple Developer account

You cannot distribute a signed build "to everyone". Locally you can open the unsigned app: right-click → **Open**, or:

```bash
xattr -cr "/Applications/Atomic Chat.app"
```
