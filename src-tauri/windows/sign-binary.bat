@echo off
rem ── Atomic Chat — Tauri signCommand wrapper ───────────────────────────────
rem Called by the Tauri bundler for every binary (main exe + sidecars)
rem BEFORE they are packaged into the NSIS / MSI installer. Signing here
rem ensures the inner Atomic-Chat.exe carries a valid Authenticode signature,
rem preventing AV heuristic detections on the embedded-but-unsigned binary
rem (e.g. Kaspersky Trojan-Downloader / UDS:DangerousObject.Multi.Generic).
rem
rem Required env vars (DigiCert KeyLocker — set by CI before this runs):
rem   SM_CERT_ALIAS            — key container alias in DigiCert One
rem   SM_API_KEY               — DigiCert API key (used by the KSP dll)
rem   SM_CLIENT_CERT_FILE      — path to the .p12 client auth certificate
rem   SM_CLIENT_CERT_PASSWORD  — password for the .p12
rem   SM_HOST                  — DigiCert One API host
rem
rem When SM_CERT_ALIAS is absent (local dev / fork PR builds) signing is
rem skipped gracefully so developers are not blocked.
rem ─────────────────────────────────────────────────────────────────────────

if "%SM_CERT_ALIAS%"=="" (
    echo [sign-binary] SM_CERT_ALIAS not set; skipping signing for: %~1
    exit /b 0
)

echo [sign-binary] Signing: %~1

signtool.exe sign ^
    /fd SHA256 ^
    /td SHA256 ^
    /tr http://timestamp.digicert.com ^
    /csp "DigiCert Signing Manager KSP" ^
    /kc "%SM_CERT_ALIAS%" ^
    "%~1"

if %ERRORLEVEL% neq 0 (
    echo [sign-binary] ERROR: signtool exited with code %ERRORLEVEL% for: %~1
    exit /b 1
)

echo [sign-binary] Signed successfully: %~1
exit /b 0
