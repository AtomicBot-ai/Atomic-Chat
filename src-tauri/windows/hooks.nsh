; Atomic Chat — NSIS installer hooks
; Extends the default Tauri uninstaller to clean application data directories
; that live outside the Tauri-managed bundle ID path.
;
; On Windows the app stores data in three locations:
;   1. %APPDATA%\chat.atomic.app\   — Tauri internal (WebView2, config) — cleaned by default
;   2. %APPDATA%\Atomic Chat\       — User data (models, threads, backends, DB)
;   3. %APPDATA%\Atomic-Chat\       — App settings (settings.json)
;
; The default Tauri NSIS template only cleans (1). These hooks clean (2) and (3)
; when the user checks "Delete app data" during uninstall.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\Atomic Chat"
    RmDir /r "$APPDATA\Atomic-Chat"
    ; Drop the per-user AUMID registration used by Toast notifications in dev builds.
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\chat.atomic.app"
  ${EndIf}
!macroend
