import { invoke } from '@tauri-apps/api/core'

let packageManaged: Promise<boolean> | null = null

/// Whether a distro package manager owns updates for this install
/// (`ATOMIC_CHAT_PACKAGE_MANAGED=1` or the marker file next to the binary —
/// see `src-tauri/src/core/updater/package_managed.rs`). Then the app must not
/// check for, offer or install updates. Fixed for the life of the process, so
/// it is asked once. Outside Tauri the command is absent and this is `false`.
export const isPackageManaged = (): Promise<boolean> => {
  packageManaged ??= invoke<boolean>('is_package_managed_install').catch(
    () => false
  )
  return packageManaged
}
