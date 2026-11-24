---
date: 2026-11-10
title: "Sign in to an Atomic Chat account from the desktop app"
---

# 2026-11-10 — Sign in to an Atomic Chat account from the desktop app

- **Context:** `api.atomic.chat` now has accounts (atomic-chat-backend PR #1): an
  email one-time code, Google through the browser with PKCE, a 15-minute EdDSA
  access token, and an opaque refresh token that rotates on every use. A
  replayed refresh token revokes the whole session. The app had no notion of a
  user. Encrypted history sync and remote access will build on this account
  later, so for now signing in gives you only the account itself: a profile and
  a device list.
- **Decision:**
  - **Rust owns the session.** It lives in `src-tauri/src/core/account/`, built
    the same way as the ChatGPT and MCP sign-ins.
    - Tokens never cross IPC. The webview gets `AccountStatus` and DTOs through
      `account_*` commands, plus an `account-changed` event.
    - The session file is `atomic-account.json` in the data folder, mode 0600.
      It is written to a temp file and renamed, so a crash cannot truncate the
      newest refresh token.
    - Refresh is single-flight under one `tokio::Mutex`.
    - `invalid_grant` ends the session. Network and server errors keep it.
    - A `401 invalid_token` triggers one refresh and one retry.
  - **Google uses a loopback redirect,** `http://127.0.0.1:<port>/auth/callback`.
    - The listener is the MCP sign-in's, now with the path as a parameter.
    - `atomic-chat://` was rejected because only macOS registers that scheme.
  - **Every sign-in sends a `client`:**
    - `desktop`;
    - the macOS Computer Name or the host name;
    - the platform;
    - the app version;
    - a random `installation_id` kept in the same file.

    The `installation_id` outlives sign-out, so signing in again replaces this
    install's previous session on the server instead of piling up devices.
  - **The UI is a rail avatar** above Help that opens Settings → Account. That
    page handles sign-in, profile, devices and deletion.
  - **Deletion that needs a fresh sign-in** re-signs in. The delete is retried
    only if the account's user id is unchanged.
  - **Factory reset** signs out first (best effort, 5 s) and removes the file.
  - **No telemetry identify and no email in analytics.**
  - **Release gate:** for now it is `PlatformFeature.ACCOUNTS`, dev builds on
    desktop only.
  - **API URL:** `ATOMIC_ACCOUNT_API_URL` points the app at another API. It
    accepts https, or http on loopback only.
- **Consequences:**
  - Later account features take tokens from `AccountState::access_token` /
    `AccountState::authed` in Rust; they don't add another store.
  - The session file is plain JSON protected only by file mode, the same as the
    ChatGPT and MCP tokens. Keychain storage would be a separate change.
  - Turning the flag on for release needs two things first: translations beyond
    en/fr, and a run in the real Tauri window.
  - Atomic Server (`atc`) and mobile are not covered and need their own clients.
- **Owner:** `team`.
- **Links:**
  - `src-tauri/src/core/account/`;
  - `web-app/src/containers/account/`;
  - atomic-chat-backend `README.md` → "Accounts API";
  - [Connect a ChatGPT subscription as a model provider](2026-08-27-connect-a-chatgpt-subscription-as-a-model-provider.md).
