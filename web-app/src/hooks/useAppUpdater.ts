import { isDev } from '@/lib/utils'
import { useState, useCallback, useEffect } from 'react'
import { events, AppEvent } from '@janhq/core'
import type { UpdateInfo } from '@/services/updater/types'
import { SystemEvent } from '@/types/events'
import { getServiceHub } from '@/hooks/useServiceHub'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'

export interface UpdateState {
  isUpdateAvailable: boolean
  updateInfo: UpdateInfo | null
  isDownloading: boolean
  downloadProgress: number
  downloadedBytes: number
  totalBytes: number
  remindMeLater: boolean
  /// Version the app is running right now, so the banner can render the
  /// `current -> new` transition ATO-533 asks for. Empty until the runtime
  /// lookup resolves, and outside Tauri it falls back to the build-time
  /// `VERSION` define.
  currentVersion: string
}

const FORCE_UPDATE_PREVIEW = import.meta.env.VITE_FORCE_UPDATE_BANNER === 'true'
export const QA_UPDATE_COMPLETE_KEY = 'atomic_qa_update_complete_version_v2'

const PREVIEW_UPDATE_INFO: UpdateInfo = {
  version: '2.0.41-preview',
  body: `## Atomic Chat 2.0.41 preview

- Rebuilt local image generation setup and model picker
- Automatic recovery after image GPU failures
- Smoother reasoning, tool activity and sidebar resizing
- Clearer approvals, downloads and project feedback
- New hardware-aware and uncensored model options`,
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/// Running app version, preferring what Tauri reports over the build-time
/// define — a `yarn dev` web session has no Tauri API at all.
const readCurrentVersion = async (): Promise<string> => {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    const version = await getVersion()
    if (version && version !== '0.0.0') return version
  } catch {
    // Not running inside Tauri.
  }
  return typeof VERSION === 'string' ? VERSION : ''
}

export const useAppUpdater = () => {
  const { t } = useTranslation()
  const previewAlreadyInstalled =
    FORCE_UPDATE_PREVIEW &&
    localStorage.getItem(QA_UPDATE_COMPLETE_KEY) === PREVIEW_UPDATE_INFO.version
  const [updateState, setUpdateState] = useState<UpdateState>({
    isUpdateAvailable: FORCE_UPDATE_PREVIEW && !previewAlreadyInstalled,
    updateInfo:
      FORCE_UPDATE_PREVIEW && !previewAlreadyInstalled
        ? PREVIEW_UPDATE_INFO
        : null,
    isDownloading: false,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    remindMeLater: false,
    currentVersion: '',
  })

  // Read once per hook instance. Cheap, and the value never changes for the
  // life of the process.
  useEffect(() => {
    let cancelled = false
    void readCurrentVersion().then((version) => {
      if (cancelled || !version) return
      setUpdateState((prev) =>
        prev.currentVersion === version
          ? prev
          : { ...prev, currentVersion: version }
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Listen for app update state sync events
  useEffect(() => {
    const handleUpdateStateSync = (newState: Partial<UpdateState>) => {
      setUpdateState((prev) => ({
        ...prev,
        ...newState,
      }))
    }

    events.on('onAppUpdateStateSync', handleUpdateStateSync)

    return () => {
      events.off('onAppUpdateStateSync', handleUpdateStateSync)
    }
  }, [])

  const syncStateToOtherInstances = useCallback(
    (partialState: Partial<UpdateState>) => {
      // Emit event to sync state across all useAppUpdater instances
      events.emit('onAppUpdateStateSync', partialState)
    },
    []
  )

  const checkForUpdate = useCallback(
    async (resetRemindMeLater = false) => {
      console.log('Checking for updates...')

      // A local QA build deliberately owns the updater state: the normal
      // startup check must not immediately replace its preview with "nothing
      // available" before the tester can inspect the banner.
      if (FORCE_UPDATE_PREVIEW) {
        const alreadyInstalled =
          localStorage.getItem(QA_UPDATE_COMPLETE_KEY) ===
          PREVIEW_UPDATE_INFO.version
        const previewState = {
          isUpdateAvailable: !alreadyInstalled,
          remindMeLater: false,
          updateInfo: alreadyInstalled ? null : PREVIEW_UPDATE_INFO,
        }
        setUpdateState((prev) => ({ ...prev, ...previewState }))
        syncStateToOtherInstances(previewState)
        return alreadyInstalled ? null : PREVIEW_UPDATE_INFO
      }

      try {
        // Reset remindMeLater if requested (e.g., when called from settings)
        if (resetRemindMeLater && !AUTO_UPDATER_DISABLED) {
          const newState = {
            remindMeLater: false,
          }
          setUpdateState((prev) => ({
            ...prev,
            ...newState,
          }))
          // Sync to other instances
          syncStateToOtherInstances(newState)
        }

        if (!isDev()) {
          // Production mode - use actual Tauri updater
          const update = await getServiceHub().updater().check()

          if (update) {
            if (AUTO_UPDATER_DISABLED) {
              console.log('Auto updater is disabled')
              return null
            }

            const newState = {
              isUpdateAvailable: true,
              remindMeLater: false,
              updateInfo: update,
            }
            setUpdateState((prev) => ({
              ...prev,
              ...newState,
            }))
            // Sync to other instances
            syncStateToOtherInstances(newState)
            console.log('Update available:', update.version)
            return update
          } else {
            // No update available - reset state
            const newState = {
              isUpdateAvailable: false,
              updateInfo: null,
            }
            setUpdateState((prev) => ({
              ...prev,
              ...newState,
            }))
            // Sync to other instances
            syncStateToOtherInstances(newState)
            return null
          }
        } else {
          const newState = {
            isUpdateAvailable: false,
            updateInfo: null,
            ...(resetRemindMeLater && { remindMeLater: false }),
          }
          setUpdateState((prev) => ({
            ...prev,
            ...newState,
          }))
          // Sync to other instances
          syncStateToOtherInstances(newState)
          return null
        }
      } catch (error) {
        console.error('Error checking for updates:', error)
        // Reset state on error
        const newState = {
          isUpdateAvailable: false,
          updateInfo: null,
        }
        setUpdateState((prev) => ({
          ...prev,
          ...newState,
        }))
        // Sync to other instances
        syncStateToOtherInstances(newState)
        return null
      }
    },
    [syncStateToOtherInstances]
  )

  const setRemindMeLater = useCallback(
    (remind: boolean) => {
      const newState = {
        remindMeLater: remind,
      }
      setUpdateState((prev) => ({
        ...prev,
        ...newState,
      }))
      // Sync to other instances
      syncStateToOtherInstances(newState)
    },
    [syncStateToOtherInstances]
  )

  const downloadAndInstallUpdate = useCallback(async () => {
    if (AUTO_UPDATER_DISABLED) {
      console.log('Auto updater is disabled')
      return
    }

    if (!updateState.updateInfo) return

    if (FORCE_UPDATE_PREVIEW) {
      const totalBytes = 48 * 1024 * 1024
      setUpdateState((prev) => ({
        ...prev,
        isDownloading: true,
        downloadProgress: 0,
        downloadedBytes: 0,
        totalBytes,
      }))
      for (const progress of [0.12, 0.38, 0.72, 1]) {
        await wait(350)
        const downloadedBytes = Math.round(totalBytes * progress)
        setUpdateState((prev) => ({
          ...prev,
          isDownloading: progress < 1,
          downloadProgress: progress,
          downloadedBytes,
        }))
        events.emit(AppEvent.onAppUpdateDownloadUpdate, {
          progress,
          downloadedBytes,
          totalBytes,
        })
      }
      localStorage.setItem(
        QA_UPDATE_COMPLETE_KEY,
        updateState.updateInfo.version
      )
      await wait(250)
      window.location.reload()
      return
    }

    try {
      setUpdateState((prev) => ({
        ...prev,
        isDownloading: true,
      }))

      let downloaded = 0
      let contentLength = 0
      await getServiceHub().models().stopAllModels()
      getServiceHub().events().emit(SystemEvent.KILL_SIDECAR)
      await new Promise((resolve) => setTimeout(resolve, 1000))

      await getServiceHub()
        .updater()
        .downloadAndInstallWithProgress((event) => {
          switch (event.event) {
            case 'Started':
              contentLength = event.data?.contentLength || 0
              setUpdateState((prev) => ({
                ...prev,
                totalBytes: contentLength,
              }))
              console.log(`Started downloading ${contentLength} bytes`)

              // Emit app update download started event
              events.emit(AppEvent.onAppUpdateDownloadUpdate, {
                progress: 0,
                downloadedBytes: 0,
                totalBytes: contentLength,
              })
              break
            case 'Progress': {
              downloaded += event.data?.chunkLength || 0
              const progress =
                contentLength > 0 ? downloaded / contentLength : 0
              setUpdateState((prev) => ({
                ...prev,
                downloadProgress: progress,
                downloadedBytes: downloaded,
              }))
              console.log(`Downloaded ${downloaded} from ${contentLength}`)

              // Emit app update download progress event
              events.emit(AppEvent.onAppUpdateDownloadUpdate, {
                progress: progress,
                downloadedBytes: downloaded,
                totalBytes: contentLength,
              })
              break
            }
            case 'Finished':
              console.log('Download finished')
              setUpdateState((prev) => ({
                ...prev,
                isDownloading: false,
                downloadProgress: 1,
              }))

              // Emit app update download success event
              events.emit(AppEvent.onAppUpdateDownloadSuccess, {})
              break
          }
        })

      if (IS_WINDOWS) {
        // NSIS .onInstSuccess (RunAsUser) is the sole relauncher on Windows.
        // Calling relaunch() here races the installer and can leave a blank shell.
        toast.info(t('updater:relaunchingWindows'))
        return
      }

      await window.core?.api?.relaunch()

      console.log('Update installed')
    } catch (error) {
      console.error('Error downloading update:', error)
      setUpdateState((prev) => ({
        ...prev,
        isDownloading: false,
      }))

      // Emit app update download error event
      events.emit(AppEvent.onAppUpdateDownloadError, {
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [updateState.updateInfo, t])

  return {
    updateState,
    checkForUpdate,
    downloadAndInstallUpdate,
    setRemindMeLater,
  }
}
