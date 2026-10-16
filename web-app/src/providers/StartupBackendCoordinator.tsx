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
  runDeferredBackendMaintenance,
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
let startupUpgradePromise: Promise<string | null> | null = null

/// See the deferred-maintenance effect below. Once per process.
let deferredMaintenanceScheduled = false

/// How long after onboarding is done (or after the app is up, for a returning
/// user) the deferred engine downloads wait: long enough not to compete with
/// the first paint and the first model load.
const DEFERRED_MAINTENANCE_DELAY_MS = 15_000

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
        gpuCount === 0,
        Date.now(),
        /// Don't spend startup I/O probing a provider the user has
        /// deactivated (TurboQuant ships disabled on fresh installs). The
        /// store is merged by now — this effect waits for onboarding state.
        (providerId) =>
          providers.find((item) => item.provider === providerId)?.active !==
          false
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
      startupUpgradePromise = applyStartupBackendUpgrade(
        ExtensionManager.getInstance(),
        result
      )
    })
    return () => {
      cancelled = true
    }
  }, [gpuCount, hardwareReady, providers])

  /// Engine downloads nobody asked for - first-run adoption of the optimal
  /// build, a newer release tag of the build in use - no longer start while
  /// the app is starting. Run them once, a while after onboarding is done,
  /// for the providers that are switched on, and after the tier upgrade above
  /// if that has already begun, so the two do not fetch at the same time.
  useEffect(() => {
    if (!isPlatformTauri() || deferredMaintenanceScheduled) return
    if (isOnboardingPending(providers)) return
    deferredMaintenanceScheduled = true
    setTimeout(() => {
      void (startupUpgradePromise ?? Promise.resolve(null))
        .catch(() => null)
        .then(() =>
          runDeferredBackendMaintenance(
            ExtensionManager.getInstance(),
            (providerId) =>
              useModelProvider
                .getState()
                .providers.find((item) => item.provider === providerId)
                ?.active !== false
          )
        )
    }, DEFERRED_MAINTENANCE_DELAY_MS)
  }, [providers])

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
