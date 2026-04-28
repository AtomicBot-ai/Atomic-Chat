import { useState, useCallback, useEffect } from 'react'
import { events, AppEvent } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'

export interface BackendUpdateInfo {
  updateNeeded: boolean
  newVersion: string
  currentVersion?: string
  targetBackend?: string
}

interface ExtensionSetting {
  key: string
  controllerProps?: {
    value: unknown
  }
}

interface BackendUpdateResult {
  wasUpdated: boolean
  reason?: 'in_progress' | 'error' | string
}

interface ExtensionWithSettings {
  getSettings?: () => Promise<ExtensionSetting[] | undefined>
}

async function getCurrentBackendTypeFromSettings(
  extension: ExtensionWithSettings
): Promise<string> {
  const settings = await extension.getSettings?.()
  const currentBackendSetting = settings?.find(
    (s) => s.key === 'version_backend'
  )
  const currentBackend = currentBackendSetting?.controllerProps?.value as string

  if (!currentBackend) {
    throw new Error('Current backend not found')
  }

  const parts = currentBackend.split('/')
  const currentVersionPart = parts[0]?.trim()
  const currentBackendType = parts[1]?.trim()

  if (parts.length !== 2 || !currentVersionPart || !currentBackendType) {
    throw new Error(
      `Invalid current backend format: "${currentBackend}". Expected "version/backendType".`
    )
  }

  return currentBackendType
}

interface LlamacppExtension {
  getSettings?(): Promise<ExtensionSetting[]>
  checkBackendForUpdates?(): Promise<BackendUpdateInfo>
  updateBackend?(
    targetBackend: string
  ): Promise<{ wasUpdated: boolean; newBackend: string }>
  installBackend?(filePath: string): Promise<void>
  configureBackends?(): Promise<void>
  downloadRecommendedBackend?(backendString: string): Promise<void>
}

export interface BackendDownloadState {
  isDownloading: boolean
  backendName: string | null
  status: 'idle' | 'downloading' | 'completed' | 'failed'
  error?: string
}

export interface BackendUpdateState {
  isUpdateAvailable: boolean
  updateInfo: BackendUpdateInfo | null
  isUpdating: boolean
  remindMeLater: boolean
  autoUpdateEnabled: boolean
}

export interface BetterBackendRecommendation {
  currentBackend: string
  recommendedBackend: string
  recommendedCategory: string
}

export type RecommendationPhase = 'idle' | 'recommend' | 'downloading' | 'restart-required'

export const useBackendUpdater = () => {
  const [updateState, setUpdateState] = useState<BackendUpdateState>({
    isUpdateAvailable: false,
    updateInfo: null,
    isUpdating: false,
    remindMeLater: false,
    autoUpdateEnabled: false,
  })

  const [downloadState, setDownloadState] = useState<BackendDownloadState>({
    isDownloading: false,
    backendName: null,
    status: 'idle',
  })

  const [recommendation, setRecommendation] = useState<BetterBackendRecommendation | null>(null)
  const [recommendationPhase, setRecommendationPhase] = useState<RecommendationPhase>('idle')

  // On mount, check localStorage for a recommendation that was persisted
  // by the extension before React mounted (avoids event race condition).
  useEffect(() => {
    try {
      const stored = localStorage.getItem('llama_cpp_better_backend_recommendation')
      if (stored) {
        const payload: BetterBackendRecommendation = JSON.parse(stored)
        if (payload.recommendedBackend && payload.recommendedCategory) {
          console.log('Better backend recommendation restored from localStorage:', payload)
          setRecommendation(payload)
          setRecommendationPhase('recommend')
        }
      }
    } catch {
      // Corrupted data — ignore
    }
  }, [])

  // Listen for the better-backend detection event from the extension
  useEffect(() => {
    const handleBetterBackendDetected = (payload: BetterBackendRecommendation) => {
      console.log('Better backend detected (event):', payload)
      setRecommendation(payload)
      setRecommendationPhase((prev) => {
        if (prev === 'downloading' || prev === 'restart-required') return prev
        return 'recommend'
      })
    }

    events.on(AppEvent.onBetterBackendDetected, handleBetterBackendDetected)

    return () => {
      events.off(AppEvent.onBetterBackendDetected, handleBetterBackendDetected)
    }
  }, [])

  // Listen for backend download events from the extension
  useEffect(() => {
    const handleDownloadStarted = (payload: { backend: string; status: string }) => {
      setDownloadState({
        isDownloading: true,
        backendName: payload.backend,
        status: 'downloading',
      })
    }

    const handleDownloadFinished = (payload: {
      backend: string
      status: 'completed' | 'failed'
      error?: string
    }) => {
      setDownloadState({
        isDownloading: false,
        backendName: payload.backend,
        status: payload.status,
        error: payload.error,
      })

      if (payload.status === 'completed' && recommendationPhase === 'downloading') {
        setRecommendationPhase('restart-required')
      } else if (payload.status === 'failed' && recommendationPhase === 'downloading') {
        setRecommendationPhase('recommend')
      }
    }

    events.on(AppEvent.onBackendDownloadStarted, handleDownloadStarted)
    events.on(AppEvent.onBackendDownloadFinished, handleDownloadFinished)

    return () => {
      events.off(AppEvent.onBackendDownloadStarted, handleDownloadStarted)
      events.off(AppEvent.onBackendDownloadFinished, handleDownloadFinished)
    }
  }, [recommendationPhase])

  // Listen for backend update state sync events
  useEffect(() => {
    const handleUpdateStateSync = (newState: Partial<BackendUpdateState>) => {
      setUpdateState((prev) => ({
        ...prev,
        ...newState,
      }))
    }

    events.on('onBackendUpdateStateSync', handleUpdateStateSync)

    return () => {
      events.off('onBackendUpdateStateSync', handleUpdateStateSync)
    }
  }, [])

  const syncStateToOtherInstances = useCallback(
    (partialState: Partial<BackendUpdateState>) => {
      events.emit('onBackendUpdateStateSync', partialState)
    },
    []
  )

  const dismissRecommendation = useCallback(() => {
    setRecommendationPhase('idle')
    // Don't remove from localStorage — popup should reappear on next launch
  }, [])

  const downloadRecommendedBackend = useCallback(async () => {
    if (!recommendation) return

    setRecommendationPhase('downloading')

    try {
      const llamacppExtension =
        ExtensionManager.getInstance().getByName('llamacpp-extension')
      let extensionToUse = llamacppExtension

      if (!llamacppExtension) {
        const allExtensions = ExtensionManager.getInstance().listExtensions()
        const possibleExtension = allExtensions.find(
          (ext) =>
            ext.constructor.name.toLowerCase().includes('llamacpp') ||
            (ext.type &&
              ext.type()?.toString().toLowerCase().includes('inference'))
        )
        if (!possibleExtension) {
          throw new Error('LlamaCpp extension not found')
        }
        extensionToUse = possibleExtension
      }

      if (!extensionToUse || !('downloadRecommendedBackend' in extensionToUse)) {
        throw new Error('Extension does not support downloadRecommendedBackend')
      }

      const extension = extensionToUse as LlamacppExtension
      await extension.downloadRecommendedBackend?.(recommendation.recommendedBackend)
    } catch (error) {
      console.error('Error downloading recommended backend:', error)
      setRecommendationPhase('recommend')
      throw error
    }
  }, [recommendation])

  const checkForUpdate = useCallback(
    async (resetRemindMeLater = false) => {
      try {
        if (resetRemindMeLater) {
          const newState = {
            remindMeLater: false,
          }
          setUpdateState((prev) => ({
            ...prev,
            ...newState,
          }))
          syncStateToOtherInstances(newState)
        }

        const allExtensions = ExtensionManager.getInstance().listExtensions()

        const llamacppExtension =
          ExtensionManager.getInstance().getByName('llamacpp-extension')

        let extensionToUse = llamacppExtension

        if (!llamacppExtension) {
          const possibleExtension = allExtensions.find(
            (ext) =>
              ext.constructor.name.toLowerCase().includes('llamacpp') ||
              (ext.type &&
                ext.type()?.toString().toLowerCase().includes('inference'))
          )

          if (!possibleExtension) {
            console.error('LlamaCpp extension not found')
            return null
          }

          extensionToUse = possibleExtension
        }

        if (!extensionToUse || !('checkBackendForUpdates' in extensionToUse)) {
          console.error(
            'Extension does not support checkBackendForUpdates method'
          )
          return null
        }

        const extension = extensionToUse as LlamacppExtension
        const updateInfo = await extension.checkBackendForUpdates?.()

        if (updateInfo?.updateNeeded) {
          const newState = {
            isUpdateAvailable: true,
            remindMeLater: false,
            updateInfo,
          }
          setUpdateState((prev) => ({
            ...prev,
            ...newState,
          }))
          syncStateToOtherInstances(newState)
          console.log('Backend update available:', updateInfo?.newVersion)
          return updateInfo
        } else {
          const newState = {
            isUpdateAvailable: false,
            updateInfo: null,
          }
          setUpdateState((prev) => ({
            ...prev,
            ...newState,
          }))
          syncStateToOtherInstances(newState)
          return null
        }
      } catch (error) {
        console.error('Error checking for backend updates:', error)
        const newState = {
          isUpdateAvailable: false,
          updateInfo: null,
        }
        setUpdateState((prev) => ({
          ...prev,
          ...newState,
        }))
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
      syncStateToOtherInstances(newState)
    },
    [syncStateToOtherInstances]
  )

  const updateBackend = useCallback(async () => {
    if (!updateState.updateInfo) return

    try {
      if (updateState.isUpdating) {
        return
      }

      setUpdateState((prev) => ({
        ...prev,
        isUpdating: true,
      }))

      const allExtensions = ExtensionManager.getInstance().listExtensions()
      const llamacppExtension =
        ExtensionManager.getInstance().getByName('llamacpp-extension')

      let extensionToUse = llamacppExtension

      if (!llamacppExtension) {
        const possibleExtension = allExtensions.find(
          (ext) =>
            ext.constructor.name.toLowerCase().includes('llamacpp') ||
            (ext.type &&
              ext.type()?.toString().toLowerCase().includes('inference'))
        )

        if (!possibleExtension) {
          throw new Error('LlamaCpp extension not found')
        }

        extensionToUse = possibleExtension
      }

      if (
        !extensionToUse ||
        !('getSettings' in extensionToUse) ||
        !('updateBackend' in extensionToUse)
      ) {
        throw new Error('Extension does not support backend updates')
      }

      const extension = extensionToUse as LlamacppExtension

      let targetBackendString = updateState.updateInfo.targetBackend

      if (targetBackendString) {
        const rawParts = targetBackendString.split('/')
        const versionPart = rawParts[0]?.trim()
        const backendTypePart = rawParts[1]?.trim()

        if (rawParts.length !== 2 || !versionPart || !backendTypePart) {
          const currentBackendType =
            await getCurrentBackendTypeFromSettings(extension)
          targetBackendString = `${updateState.updateInfo.newVersion}/${currentBackendType}`
        } else {
          targetBackendString = `${versionPart}/${backendTypePart}`
        }
      } else {
        const currentBackendType =
          await getCurrentBackendTypeFromSettings(extension)
        targetBackendString = `${updateState.updateInfo.newVersion}/${currentBackendType}`
      }

      const rawResult = await extension.updateBackend?.(targetBackendString)
      const result = rawResult as BackendUpdateResult | undefined

      if (result?.wasUpdated === true) {
        const newState = {
          isUpdateAvailable: false,
          updateInfo: null,
          isUpdating: false,
        }
        setUpdateState((prev) => ({
          ...prev,
          ...newState,
        }))
        syncStateToOtherInstances(newState)
      } else if (
        result?.wasUpdated === false &&
        (result.reason === 'in_progress' ||
          typeof result.reason === 'undefined')
      ) {
        setUpdateState((prev) => ({
          ...prev,
          isUpdating: false,
        }))
      } else if (
        result?.wasUpdated === false &&
        result.reason &&
        result.reason !== 'in_progress'
      ) {
        throw new Error(`Backend update failed: ${result.reason}`)
      } else {
        throw new Error('Backend update failed')
      }
    } catch (error) {
      console.error('Error updating backend:', error)
      setUpdateState((prev) => ({
        ...prev,
        isUpdating: false,
      }))
      throw error
    }
  }, [
    updateState.updateInfo,
    updateState.isUpdating,
    syncStateToOtherInstances,
  ])

  const installBackend = useCallback(async (filePath: string) => {
    try {
      const allExtensions = ExtensionManager.getInstance().listExtensions()
      const llamacppExtension =
        ExtensionManager.getInstance().getByName('llamacpp-extension')

      let extensionToUse = llamacppExtension

      if (!llamacppExtension) {
        const possibleExtension = allExtensions.find(
          (ext) =>
            ext.constructor.name.toLowerCase().includes('llamacpp') ||
            (ext.type &&
              ext.type()?.toString().toLowerCase().includes('inference'))
        )

        if (!possibleExtension) {
          throw new Error('LlamaCpp extension not found')
        }

        extensionToUse = possibleExtension
      }

      if (!extensionToUse || !('installBackend' in extensionToUse)) {
        throw new Error('Extension does not support backend installation')
      }

      const extension = extensionToUse as LlamacppExtension
      await extension.installBackend?.(filePath)

      await extension.configureBackends?.()
    } catch (error) {
      console.error('Error installing backend:', error)
      throw error
    }
  }, [])

  return {
    updateState,
    downloadState,
    recommendation,
    recommendationPhase,
    checkForUpdate,
    updateBackend,
    setRemindMeLater,
    installBackend,
    dismissRecommendation,
    downloadRecommendedBackend,
  }
}
