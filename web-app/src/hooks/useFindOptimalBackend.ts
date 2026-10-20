import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import type {
  UseBackendUpdaterConfig,
  useBackendUpdater,
} from '@/hooks/useBackendUpdater'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

/**
 * The backend updater an engine's page talks to. The turboquant provider
 * (`llamacpp`) ships alongside upstream on Windows/Linux, and PrismML keeps
 * its own packs under `atomic-prism/backends`: each owns its own backend tree
 * and localStorage keys, so the updater is configured per provider to avoid
 * cross-contamination (see the 2026-06-23 turboquant-on-Win/Linux ADR).
 * Upstream is the updater's default.
 */
export function backendUpdaterConfigFor(
  providerName: string
): UseBackendUpdaterConfig {
  if (providerName === 'llamacpp') {
    return {
      extensionName: '@janhq/llamacpp-extension',
      providerId: 'llamacpp',
      recommendationKey: 'turboquant_better_backend_recommendation',
      postUpgradeRecheckEnabled: false,
    }
  }
  if (providerName === 'atomic-prism') {
    return {
      extensionName: '@janhq/atomic-prism-extension',
      providerId: 'atomic-prism',
      recommendationKey: 'atomic_prism_better_backend_recommendation',
      postUpgradeRecheckEnabled: false,
    }
  }
  return {}
}

/**
 * Whether "Find optimal backend" is offered for this engine: the two local
 * llama.cpp providers on Windows and Linux, which resolve their own backend
 * catalogs. macOS uses the separate turboquant pipeline with no alternate
 * backend matrix.
 */
export function offersOptimalBackend(providerName: string): boolean {
  return (
    (IS_WINDOWS || IS_LINUX) &&
    (providerName === LOCAL_LLAMACPP_PROVIDER || providerName === 'llamacpp')
  )
}

type OptimalBackendUpdater = Pick<
  ReturnType<typeof useBackendUpdater>,
  'recheckOptimalBackend' | 'downloadRecommendedBackend' | 'recommendationPhase'
>

/**
 * "Find optimal backend", the manual replacement for the legacy auto-popup:
 * re-runs hardware detection on demand and, when a better backend is
 * available, immediately starts the download. The user explicitly asked to
 * find AND install, so there is no extra confirmation.
 *
 * `busy` covers the whole pipeline — detection, download, hot-swap — not only
 * the (fast) detection, so the spinner does not flicker off while the heavy
 * lifting continues in `useBackendUpdater`; the global `<BackendUpdater />`
 * dialog shows the download and restart states.
 */
export function useFindOptimalBackend(
  providerName: string,
  updater: OptimalBackendUpdater
) {
  const { t } = useTranslation()
  const { recheckOptimalBackend, downloadRecommendedBackend } = updater
  const [checking, setChecking] = useState(false)

  const find = useCallback(async () => {
    // The optimal-backend matrix exists for the local llama.cpp engines: the
    // upstream provider (`LOCAL_LLAMACPP_PROVIDER`) on every desktop OS, plus
    // the turboquant provider (`llamacpp`) which ships its own catalog on
    // Windows/Linux. Anything else has no per-host backend variants.
    const isOptimalCapable =
      providerName === LOCAL_LLAMACPP_PROVIDER ||
      (providerName === 'llamacpp' && (IS_WINDOWS || IS_LINUX))
    if (!isOptimalCapable) return
    setChecking(true)
    try {
      const result = await recheckOptimalBackend()
      if (!result) {
        toast.success(t('settings:backendUpdater.alreadyOptimal'))
        return
      }
      // Pass the freshly-detected backend explicitly: the hook's internal
      // `recommendation` state was queued by `recheckOptimalBackend` but not
      // committed yet, so a call without an argument would still see the
      // previous (often null) value and silently bail.
      void downloadRecommendedBackend(result.recommendedBackend).catch(
        (err) => {
          console.error('Optimal backend download failed:', err)
          toast.error(t('settings:backendUpdater.downloadFailed'))
        }
      )
    } catch (error) {
      // ATO-161: distinguish "detection couldn't complete" (e.g. the ggml-org
      // release stream / api.github.com was unreachable, slow, or
      // rate-limited) from a genuine failure. The extension throws the
      // `BACKEND_DETECTION_FAILED` sentinel in that case; surface a calm,
      // actionable message and leave the current backend untouched instead
      // of the misleading "you're already on the optimal backend".
      if (
        error instanceof Error &&
        error.message === 'BACKEND_DETECTION_FAILED'
      ) {
        toast.info(t('settings:backendUpdater.detectionUnavailable'))
        return
      }
      console.error('Failed to recheck optimal backend:', error)
      toast.error(t('settings:backendUpdater.findOptimalFailed'))
    } finally {
      setChecking(false)
    }
  }, [providerName, recheckOptimalBackend, downloadRecommendedBackend, t])

  const phase = updater.recommendationPhase
  const busy = checking || phase === 'downloading' || phase === 'hotswapping'
  const label = checking
    ? t('settings:backendUpdater.findOptimalChecking')
    : phase === 'downloading'
      ? t('settings:backendUpdater.findOptimalDownloading')
      : phase === 'hotswapping'
        ? t('settings:backendUpdater.findOptimalSwitching')
        : t('settings:backendUpdater.findOptimalAction')

  return { find, busy, label }
}
