import { useEffect, useState } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useBackendMismatch } from '@/hooks/useBackendMismatch'
import type { OptimalBackendCacheRecord } from '@/hooks/useBackendUpdater'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ExtensionManager } from '@/lib/extension'
import { isOnboardingPending } from '@/lib/onboarding'
import { isPlatformTauri } from '@/lib/platform/utils'
import {
  applyStartupBackendUpgrade,
  buildLateBackendMismatch,
  refreshStartupBackendCaches,
} from '@/lib/startupBackendRecommendations'

let startupRefreshPromise:
  | Promise<
      Partial<
        Record<OptimalBackendCacheRecord['provider'], OptimalBackendCacheRecord>
      >
    >
  | null = null

/// The effect below can re-run (hardware/provider state settles in steps) and
/// `startupRefreshPromise` is cached, so its `.then` fires again each time. The
/// tier upgrade must be attempted once per process.
let startupUpgradeStarted = false

/**
 * Warms provider-specific optimal-backend knowledge without opening startup UI.
 * Normal model-load reporting consumes the cache. The second effect below also
 * covers the race where detection finishes just after a CPU model has loaded.
 */
export function StartupBackendCoordinator() {
  const providers = useModelProvider((state) => state.providers)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const selectedModel = useModelProvider((state) => state.selectedModel)
  const activeModels = useAppState((state) => state.activeModels)
  const hardwareReady = useHardware((state) => state.hardwareReady)
  const gpuCount = useHardware((state) => state.hardwareData.gpus.length)
  const { report } = useBackendMismatch()
  const [records, setRecords] = useState<
    Partial<Record<OptimalBackendCacheRecord['provider'], OptimalBackendCacheRecord>>
  >({})

  useEffect(() => {
    if (!isPlatformTauri() || (!IS_WINDOWS && !IS_LINUX)) return
    if (!hardwareReady || isOnboardingPending(providers)) return

    if (!startupRefreshPromise) {
      startupRefreshPromise = refreshStartupBackendCaches(
        ExtensionManager.getInstance(),
        gpuCount === 0
      )
    }

    let cancelled = false
    void startupRefreshPromise.then((result) => {
      if (cancelled) return
      setRecords(result)
      if (startupUpgradeStarted) return
      startupUpgradeStarted = true
      /// Detection already knows which build this host should run; apply it
      /// instead of only using the record for the in-chat hint. Guarded and
      /// scoped to the upstream provider inside the helper.
      void applyStartupBackendUpgrade(ExtensionManager.getInstance(), result)
    })
    return () => {
      cancelled = true
    }
  }, [gpuCount, hardwareReady, providers])

  useEffect(() => {
    const record =
      selectedProvider === 'llamacpp' ||
      selectedProvider === 'llamacpp-upstream'
        ? records[selectedProvider]
        : null

    const provider = providers.find((item) => item.provider === selectedProvider)
    const currentVersionBackend = String(
      provider?.settings.find((setting) => setting.key === 'version_backend')
        ?.controller_props?.value ?? ''
    )
    const lateMismatch = buildLateBackendMismatch({
      record: record ?? null,
      provider: selectedProvider,
      modelId: selectedModel?.id ?? null,
      modelIsActive: Boolean(
        selectedModel?.id && activeModels.includes(selectedModel.id)
      ),
      currentVersionBackend,
    })
    if (lateMismatch) report(lateMismatch)
  }, [
    activeModels,
    providers,
    records,
    report,
    selectedModel?.id,
    selectedProvider,
  ])

  return null
}
