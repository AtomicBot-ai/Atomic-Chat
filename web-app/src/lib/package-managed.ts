import { invoke } from '@tauri-apps/api/core'

let packageManaged: Promise<boolean> | null = null

/// Whether a distro package manager owns updates for this install
/// (`ATOMIC_CHAT_PACKAGE_MANAGED=1` or the marker file next to the binary —
/// see `src-tauri/src/core/updater/package_managed.rs`). Then the app must not
/// check for, offer or install updates. Fixed for the life of the process, so
/// an answer is asked for once. A rejection (no Tauri, or the IPC not ready
/// yet) reads as `false` for that call only and is asked again next time, so a
/// single failed lookup can never turn the updater back on for good.
export const isPackageManaged = (): Promise<boolean> => {
  if (packageManaged === null) {
    const lookup = invoke<boolean>('is_package_managed_install').catch(() => {
      if (packageManaged === lookup) packageManaged = null
      return false
    })
    packageManaged = lookup
  }
  return packageManaged
}
