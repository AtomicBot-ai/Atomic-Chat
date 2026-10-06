; Atomic Chat — NSIS installer hooks
; Extends the default Tauri installer to stop a leftover app core before it
; overwrites the core's binary, and the default Tauri uninstaller to:
;   1. Kill helper processes that hold file locks BEFORE removing files.
;   2. Clean application data directories that live outside the Tauri-managed
;      bundle ID path when the user opts in to "Delete app data".
;
; On Windows the app stores data in four locations:
;   1. %APPDATA%\chat.atomic.app\               — Tauri-internal store +
;                                                 settings.json (new installs).
;                                                 Cleaned by Tauri default.
;   2. %APPDATA%\Atomic Chat\                   — User data folder
;                                                 (models, threads, backends,
;                                                 logs, store.json,
;                                                 mcp_config.json).
;                                                 NOT cleaned by Tauri default.
;   3. %APPDATA%\Atomic-Chat\                   — Legacy settings.json
;                                                 (only on older installs;
;                                                 path uses CARGO_PKG_NAME).
;   4. %LOCALAPPDATA%\chat.atomic.app\EBWebView — WebView2 cache + localStorage.
;                                                 Cleaned by Tauri default,
;                                                 but on perUser/passive
;                                                 installs lockfiles can be
;                                                 left behind, so we redo it.
;   5. %APPDATA%\atomic-managed-runtimes\     — TensorRT-LLM setup state
;                                                 (operations, cached conf
;                                                 documents, environment.json).
;   6. %LOCALAPPDATA%\AtomicChat\              — the TensorRT-LLM WSL
;                                                 distribution's disk, its
;                                                 rootfs download, host steps.
;      With "Delete app data", the distribution environment.json records as
;      ours is unregistered first (wsl --unregister), then 5 and 6 go: a
;      reinstall then starts the TensorRT-LLM setup from scratch. Deleting 5
;      without unregistering would leave a distribution the next core sees
;      as someone else's and refuses to touch.
;
; A custom data_folder set by the user via "Change data folder location"
; is NOT covered by these hooks — the user is responsible for cleaning it.

!macro NSIS_HOOK_PREINSTALL
  ; The app starts its core (resources\bin\atomic-chat-app-core.exe) detached,
  ; and only a full quit through RunEvent::Exit stops it. An update does not
  ; quit that way: the updater launches this installer and calls
  ; std::process::exit(0), so the core lives on until its client lease runs
  ; out (about 45 s) and keeps its binary locked while we overwrite it. /T
  ; takes its llama-server / sd-server / cloudflared children with it.
  ;
  ; Only once the app itself is gone. In an update it has already exited, even
  ; if its process is still winding down. In a manual install over a running
  ; app, CheckIfAppIsRunning (right after this hook) asks first: stopping the
  ; core behind a user who then cancels would break their session, and the app
  ; would start another one anyway.
  ${If} $UpdateMode = 1
    StrCpy $R0 1
  ${Else}
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    !else
      nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
    !endif
    ; 0 means the app is running.
    Pop $R0
  ${EndIf}
  ${If} $R0 <> 0
    nsExec::Exec 'taskkill /F /T /IM "atomic-chat-app-core.exe"'
    Pop $0
    ; taskkill exits 0 only when it stopped something; give the kernel a
    ; moment to release the file handles then.
    ${If} $0 == 0
      Sleep 1500
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri's CheckIfAppIsRunning macro (called later in the Section Uninstall
  ; from the bundle template) already handles the main binary. Here we kill
  ; helper processes that the app spawns and that frequently keep WebView2
  ; / data files locked when the uninstaller tries to RmDir /r.
  ;
  ; We use taskkill so we don't depend on the nsProcess plugin being bundled.
  ; /T terminates child processes too. Errors are silently ignored — the
  ; process may simply not be running.
  nsExec::Exec 'taskkill /F /T /IM "atomic-chat-app-core.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "llama-server.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "bun.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "uv.exe"'
  Pop $0

  ; msedgewebview2.exe is shared with other Edge-based apps on the system —
  ; we must only kill instances that belong to *our* WebView2 user data
  ; directory (%LOCALAPPDATA%\chat.atomic.app). PowerShell filters by the
  ; process MainModule path. -EA SilentlyContinue + try/catch so we never
  ; abort uninstall if PowerShell is missing or a process exits mid-query.
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object { try { $_.MainModule.FileName -like \"*chat.atomic.app*\" } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0

  ; Give the kernel a moment to release file handles after TerminateProcess.
  Sleep 1500
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ; Clean the user data folder (models, backends, threads, logs, ...).
    RmDir /r "$APPDATA\Atomic Chat"
    ; Clean the legacy settings.json folder (older builds).
    RmDir /r "$APPDATA\Atomic-Chat"
    ; Tauri default already removes %LOCALAPPDATA%\chat.atomic.app, but
    ; perUser/passive uninstalls sometimes leave EBWebView lockfiles behind.
    ; Redo it idempotently — no-op if the directory is already gone.
    RmDir /r "$LOCALAPPDATA\chat.atomic.app"
    ; Drop the per-user AUMID registration used by Toast notifications in dev builds.
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\chat.atomic.app"

    ; TensorRT-LLM: unregister the WSL distribution our environment record names
    ; (only that one, and only a plain name), then drop its state and its disk.
    ; Sysnative: this uninstaller is a 32-bit process, and System32 would be
    ; redirected to SysWOW64, which has no wsl.exe. Errors are ignored: no
    ; record, no WSL, or an already unregistered distribution all mean there
    ; is nothing to unregister.
    nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $$r = Get-Content -Raw -LiteralPath '$APPDATA\atomic-managed-runtimes\environment.json' | ConvertFrom-Json; $$n = [string]$$r.distribution.name; if ($$n -match '^[A-Za-z0-9._-]{1,64}$$') { $$w = Join-Path $$env:WINDIR 'Sysnative\wsl.exe'; if (-not (Test-Path $$w)) { $$w = Join-Path $$env:WINDIR 'System32\wsl.exe' }; & $$w --unregister $$n } } catch { }"`
    Pop $0
    RmDir /r "$APPDATA\atomic-managed-runtimes"
    RmDir /r "$LOCALAPPDATA\AtomicChat"
  ${EndIf}
!macroend
