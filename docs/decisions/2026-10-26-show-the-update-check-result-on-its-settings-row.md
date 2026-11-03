---
date: 2026-10-26
title: 'Show the update check result on its Settings row'
---

# 2026-10-26 — Show the update check result on its Settings row

- **Context:** QA 2.2.25 NEW-01: Settings → General → Check for Updates went
  "Checking for updates" → idle twice with nothing visible, while the log
  shows both checks finished ("No update needed: current 2.2.25 is up to date
  with latest 2.2.23"). The only feedback was a transient `toast.info`. And a
  check that failed could not be told from one that found nothing:
  `TauriUpdaterService.check()` and `useAppUpdater.checkForUpdate` both caught
  errors and answered `null`, so the page's error branch was unreachable and
  a failed check read as "you're running the latest version".
- **Decision:**
  - **The row keeps the result.** The row's description line is a polite live
    region (`role="status"`, always mounted): the description until a check,
    then "Checking for updates…", then the result, kept until the next check —
    up to date with the running version and the time checked; the version
    available (installed from the update notice, which the check brings back
    if it was dismissed); could not check, with the time, and the button reads
    "Try again"; a development build does not check. No toast.
  - **A failed check is a failure.** `TauriUpdaterService.check()` rejects
    when neither the signed check nor the plugin fallback got an answer. When
    the signed check answered "no update", a failing plugin check after it
    still resolves `null`.
  - **Two callers, one check.** `useAppUpdater` runs one check that returns
    an `UpdateCheckOutcome` (`available` / `up-to-date` / `failed` /
    `not-checked` with `development`, `disabled` or `package-managed`).
    `checkForUpdate` — startup and the periodic timer — maps it to the update
    or `null`, exactly as before, so a failure stays silent there.
    `checkForUpdateNow` returns the outcome to Settings.
  - **Builds that do not update themselves say so.** A package-managed install
    keeps its "Update it there" row. An `AUTO_UPDATER_DISABLED` build, which
    showed no update row at all, now shows "This build doesn't update itself."
- **Consequences:** The result survives a slow machine and a missed toast,
  and screen readers hear it. It lives in the page's state, so leaving
  Settings and coming back shows the description again. The background check
  still never reports a failure to the user.
- **Owner:** `team`
- **Links:** `web-app/src/routes/settings/general.tsx`,
  `web-app/src/hooks/useAppUpdater.ts`,
  `web-app/src/services/updater/tauri.ts`; QA package
  atomic-chat-e2e-2026-10-23 (NEW-01, log 14:10:52 and 14:11:12 UTC).
