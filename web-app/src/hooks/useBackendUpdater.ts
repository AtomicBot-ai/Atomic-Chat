import { useState, useCallback, useEffect, useRef } from 'react'
import { events, AppEvent } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { localStorageKey } from '@/constants/localStorage'
import {
  LOCAL_LLAMACPP_EXTENSION_NAME,
  LOCAL_LLAMACPP_PROVIDER,
} from '@/lib/utils'
import { WINDOWS_RECHECK_PENDING_KEY } from '@/lib/windowsProviderMigration'
import { captureBackendRecommendationDismissed } from '@/lib/backend-telemetry'
import { friendlyBackendLabel } from '@/lib/backendLabel'
import type { EngineId } from '@/services/engines/types'
import { switchBackendThroughCore } from '@/services/engines/update'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

/// Maximum time we wait for a `app:backend-hotswapped` window event after the
/// backend archive download finishes. If no switch is ever reported, fall back
/// to the legacy "restart required" prompt so the user is not stranded in an
/// indefinite "switching" spinner.
const HOTSWAP_TIMEOUT_MS = 8000

/// How long the "completed" success state stays on screen before the dialog
/// auto-dismisses. Long enough for the user to read the toast / banner,
/// short enough to feel snappy.
const HOTSWAP_COMPLETED_DISMISS_MS = 1500

const BACKEND_HOTSWAPPED_EVENT = 'app:backend-hotswapped'

/// Default localStorage key the upstream extension persists its
/// recommendation under (read on mount, before any Tauri event arrives).
/// A turboquant-configured instance overrides this with its own key so the
/// two providers never clobber each other on Windows/Linux where both ship.
const DEFAULT_RECOMMENDATION_KEY = 'llama_cpp_better_backend_recommendation'

/// Per-provider configuration for {@link useBackendUpdater}. Omitting it
/// (the default) targets the upstream llama.cpp provider exactly as before,
/// so every existing call site is unchanged.
export interface UseBackendUpdaterConfig {
  /// `@janhq/...` package id of the extension that owns this provider's
  /// backends. Defaults to the upstream extension.
  extensionName?: string
  /// Provider id used to route `onBetterBackendDetected` events. Untagged
  /// payloads are attributed to the default upstream provider. Defaults to
  /// `LOCAL_LLAMACPP_PROVIDER`.
  providerId?: string
  /// localStorage key the owning extension persists its recommendation under.
  /// Defaults to the upstream key.
  recommendationKey?: string
  /// Whether this instance runs the post-upgrade Windows auto-recheck. Only
  /// the default upstream instance should — a secondary turboquant instance
  /// passes `false` to avoid double-firing detection. Defaults to `true`.
  postUpgradeRecheckEnabled?: boolean
}

export type OptimalBackendCacheRecord = {
  schemaVersion: 1
  provider: 'llamacpp' | 'llamacpp-upstream' | 'atomic-prism'
  detectedAt: number
  detectionKind: 'gpu' | 'cpu-optimal'
  currentBackend: string
  idealBackendId?: string
  recommendedBackend?: string
  recommendedCategory?: string
}

/// Outcome of an explicit engine-update check. The check only decides; the
/// caller starts the download.
export type EngineUpdateResult = {
  updateAvailable: boolean
  targetBackend: string | null
}

interface LlamacppExtension {
  installBackend?(filePath: string): Promise<void>
  configureBackends?(): Promise<void>
  recheckOptimalBackend?(): Promise<BetterBackendRecommendation | null>
  /** `latest/<variant>` → the concrete `<version>/<variant>` it means here. */
  resolveBackendSelection?(selection: string): Promise<string>
  getCachedOptimalBackend?(): OptimalBackendCacheRecord | null
  refreshOptimalBackendCache?(options?: {
    hardwareHasNoGpu?: boolean
  }): Promise<OptimalBackendCacheRecord | null>
}

export interface BackendDownloadState {
  isDownloading: boolean
  backendName: string | null
  status: 'idle' | 'downloading' | 'completed' | 'failed'
  error?: string
}

export interface BetterBackendRecommendation {
  currentBackend: string
  recommendedBackend: string
  recommendedCategory: string
  /// Provider id the recommendation belongs to. Set by the turboquant
  /// extension (`'llamacpp'`); absent on legacy upstream payloads, which are
  /// then attributed to the default upstream provider for routing.
  provider?: string
  /// Release tag the recommended backend belongs to, e.g. `b10018-1.3.0`.
  version?: string
  /// Concrete clean backend id, e.g. `linux-x64-rocm`.
  backendId?: string
}

export type RecommendationPhase =
  | 'idle'
  | 'recommend'
  | 'downloading'
  | 'hotswapping'
  | 'completed'
  | 'restart-required'

/// How long "Not now" keeps the recommendation dialog down.
export const RECOMMENDATION_SNOOZE_DAYS = 7

export function isRecommendationSnoozed(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(
      localStorageKey.backendRecommendationSnoozedUntil
    )
    const until = raw ? Number(raw) : NaN
    return Number.isFinite(until) && until > now
  } catch {
    return false
  }
}

function snoozeRecommendation(now = Date.now()): void {
  try {
    localStorage.setItem(
      localStorageKey.backendRecommendationSnoozedUntil,
      String(now + RECOMMENDATION_SNOOZE_DAYS * 24 * 60 * 60 * 1000)
    )
  } catch {
    // Storage unavailable: the dialog simply returns next launch, as before.
  }
}

export const useBackendUpdater = (config: UseBackendUpdaterConfig = {}) => {
  const extensionName = config.extensionName ?? LOCAL_LLAMACPP_EXTENSION_NAME
  const providerId = config.providerId ?? LOCAL_LLAMACPP_PROVIDER
  const recommendationKey = config.recommendationKey ?? DEFAULT_RECOMMENDATION_KEY
  const postUpgradeRecheckEnabled = config.postUpgradeRecheckEnabled ?? true

  const [downloadState, setDownloadState] = useState<BackendDownloadState>({
    isDownloading: false,
    backendName: null,
    status: 'idle',
  })

  const [recommendation, setRecommendation] = useState<BetterBackendRecommendation | null>(null)
  const [recommendationPhase, setRecommendationPhase] = useState<RecommendationPhase>('idle')

  /// Tracks pending hot-swap fallback timer so it can be cancelled when the
  /// `app:backend-hotswapped` window event arrives in time.
  const hotswapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /// Tracks the auto-dismiss timer for the 'completed' success state.
  const completedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHotswapTimeout = useCallback(() => {
    if (hotswapTimeoutRef.current) {
      clearTimeout(hotswapTimeoutRef.current)
      hotswapTimeoutRef.current = null
    }
  }, [])

  const clearCompletedTimeout = useCallback(() => {
    if (completedTimeoutRef.current) {
      clearTimeout(completedTimeoutRef.current)
      completedTimeoutRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      clearHotswapTimeout()
      clearCompletedTimeout()
    }
  }, [clearHotswapTimeout, clearCompletedTimeout])

  // On mount, check localStorage for a recommendation that was persisted
  // by the extension before React mounted (avoids event race condition
  // during the in-flight onboarding step).
  //
  // Suppress this auto-restore once any of these terminal flags is set:
  //   - `llama_cpp_onboarding_done` — user finished the dedicated step.
  //   - `setup-completed` — legacy users who never went through the new
  //     onboarding (pre-existing installs upgrading to this version).
  // After that point any surfacing must come from a fresh Tauri event,
  // either via the gated `configureBackends()` path or the manual
  // "Find optimal backend" button (`recheckOptimalBackend()`).
  useEffect(() => {
    try {
      if (
        localStorage.getItem(localStorageKey.llamacppOnboardingDone) ||
        localStorage.getItem(localStorageKey.setupCompleted) === 'true'
      ) {
        return
      }
      const stored = localStorage.getItem(recommendationKey)
      if (stored) {
        const payload: BetterBackendRecommendation = JSON.parse(stored)
        if (payload.recommendedBackend && payload.recommendedCategory) {
          console.log('Better backend recommendation restored from localStorage:', payload)
          setRecommendation(payload)
          if (!isRecommendationSnoozed()) setRecommendationPhase('recommend')
        }
      }
    } catch {
      // Corrupted data — ignore
    }
  }, [recommendationKey])

  /// Provider routing for every backend event this hook consumes.
  ///
  /// Both llama.cpp providers ship side by side on Windows/Linux and each has
  /// its own optimal backend for the same hardware, so an event is only ours
  /// when it carries our provider id. An untagged payload is attributed to the
  /// default upstream provider, which is what every legacy emitter was.
  const isOurEvent = useCallback(
    (payload: { provider?: string } | null | undefined) =>
      (payload?.provider ?? LOCAL_LLAMACPP_PROVIDER) === providerId,
    [providerId]
  )

  // Listen for the better-backend detection event from the extension
  useEffect(() => {
    const handleBetterBackendDetected = (payload: BetterBackendRecommendation) => {
      if (!isOurEvent(payload)) return
      console.log('Better backend detected (event):', payload)
      setRecommendation(payload)
      // Kept as state either way so the settings button can still act on
      // it; only the unasked-for prompt respects the snooze.
      if (isRecommendationSnoozed()) return
      setRecommendationPhase((prev) => {
        if (prev === 'downloading' || prev === 'restart-required') return prev
        return 'recommend'
      })
    }

    events.on(AppEvent.onBetterBackendDetected, handleBetterBackendDetected)

    return () => {
      events.off(AppEvent.onBetterBackendDetected, handleBetterBackendDetected)
    }
  }, [isOurEvent])

  // Listen for backend download events from the extension.
  //
  // Cross-instance phase sync: each `useBackendUpdater()` call is a
  // separate React state owner, so when one component (e.g. the
  // settings page) starts a download the global `<BackendUpdater />`
  // mounted in `__root.tsx` would otherwise stay frozen in 'recommend'.
  // Use the `payload.backend === recommendation.recommendedBackend`
  // match to drive the phase transitions from events alone, regardless
  // of which component initiated the download.
  useEffect(() => {
    const handleDownloadStarted = (payload: {
      backend: string
      status: string
      provider?: string
    }) => {
      if (!isOurEvent(payload)) return
      setDownloadState({
        isDownloading: true,
        backendName: payload.backend,
        status: 'downloading',
      })
      if (
        recommendation &&
        payload.backend === recommendation.recommendedBackend &&
        recommendationPhase !== 'restart-required'
      ) {
        clearHotswapTimeout()
        clearCompletedTimeout()
        setRecommendationPhase('downloading')
      }
    }

    const handleDownloadFinished = (payload: {
      backend: string
      status: 'completed' | 'failed'
      error?: string
      provider?: string
    }) => {
      if (!isOurEvent(payload)) return
      setDownloadState({
        isDownloading: false,
        backendName: payload.backend,
        status: payload.status,
        error: payload.error,
      })

      const targetsRecommendation =
        !!recommendation && payload.backend === recommendation.recommendedBackend

      if (payload.status === 'completed') {
        if (recommendationPhase === 'downloading' || targetsRecommendation) {
          // Move to 'hotswapping' and arm a fallback timer in case the
          // extension's `applyBackendLive()` path silently fails (no
          // `app:backend-hotswapped` event will be dispatched in that
          // case). On timeout we revert to the legacy restart-required
          // UX so the user is never stuck in an indefinite spinner.
          setRecommendationPhase('hotswapping')
          clearHotswapTimeout()
          hotswapTimeoutRef.current = setTimeout(() => {
            hotswapTimeoutRef.current = null
            setRecommendationPhase((prev) =>
              prev === 'hotswapping' ? 'restart-required' : prev
            )
          }, HOTSWAP_TIMEOUT_MS)
        }
      } else if (payload.status === 'failed') {
        if (recommendationPhase === 'downloading' || targetsRecommendation) {
          setRecommendationPhase('recommend')
        }
      }
    }

    events.on(AppEvent.onBackendDownloadStarted, handleDownloadStarted)
    events.on(AppEvent.onBackendDownloadFinished, handleDownloadFinished)

    return () => {
      events.off(AppEvent.onBackendDownloadStarted, handleDownloadStarted)
      events.off(AppEvent.onBackendDownloadFinished, handleDownloadFinished)
    }
  }, [recommendationPhase, recommendation, clearHotswapTimeout, clearCompletedTimeout, isOurEvent])

  // Listen for the live hot-swap completion event dispatched by
  // `applyBackendLive()` in the llamacpp extension. The event arrives on
  // the DOM `window` because the extension does not depend on the
  // `@janhq/core` event bus for this purely UI-facing transition.
  useEffect(() => {
    const handleHotswapped = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string }>).detail
      if (!isOurEvent(detail)) return
      clearHotswapTimeout()
      setRecommendationPhase('completed')
      clearCompletedTimeout()
      completedTimeoutRef.current = setTimeout(() => {
        completedTimeoutRef.current = null
        setRecommendation(null)
        setRecommendationPhase('idle')
      }, HOTSWAP_COMPLETED_DISMISS_MS)
    }

    window.addEventListener(BACKEND_HOTSWAPPED_EVENT, handleHotswapped)
    return () => {
      window.removeEventListener(BACKEND_HOTSWAPPED_EVENT, handleHotswapped)
    }
  }, [clearHotswapTimeout, clearCompletedTimeout, isOurEvent])

  // Manual "Latest <variant>" selection flow (extension-driven). The
  // extension's `downloadManualBackend()` emits these dedicated events so the
  // dialog can open straight into the 'downloading' spinner without the
  // 'recommend' confirm flash / event-ordering race that reusing
  // `onBetterBackendDetected` + `onBackendDownloadStarted` would incur.
  //   - `onManualBackendDownloading`: set recommendation + phase in one go.
  //   - `onManualBackendFailed`: dismiss the dialog (offline + nothing
  //     installed to fall back to). The subsequent download / hot-swap
  //     progression reuses the standard `onBackendDownloadFinished` +
  //     `app:backend-hotswapped` listeners above.
  useEffect(() => {
    const handleManualDownloading = (payload: BetterBackendRecommendation) => {
      if (!isOurEvent(payload)) return
      clearHotswapTimeout()
      clearCompletedTimeout()
      setRecommendation(payload)
      setRecommendationPhase('downloading')
    }
    const handleManualFailed = (payload?: { provider?: string }) => {
      if (!isOurEvent(payload)) return
      clearHotswapTimeout()
      clearCompletedTimeout()
      setRecommendation(null)
      setRecommendationPhase('idle')
    }

    events.on('onManualBackendDownloading', handleManualDownloading)
    events.on('onManualBackendFailed', handleManualFailed)

    return () => {
      events.off('onManualBackendDownloading', handleManualDownloading)
      events.off('onManualBackendFailed', handleManualFailed)
    }
  }, [clearHotswapTimeout, clearCompletedTimeout, isOurEvent])

  /// "Not now" means not for a while, not "ask me again at the next launch":
  /// the dialog used to return every single start for anyone who declined.
  /// The recommendation itself is kept, so the settings page's "Find optimal
  /// backend" and the startup upgrade are unaffected.
  const dismissRecommendation = useCallback(() => {
    setRecommendationPhase('idle')
    snoozeRecommendation()
    captureBackendRecommendationDismissed({
      provider: providerId,
      backendFrom: null,
      backendTo: recommendation?.recommendedBackend ?? null,
      trigger: 'dialog',
      snoozedForDays: RECOMMENDATION_SNOOZE_DAYS,
    })
  }, [providerId, recommendation])

  /// `overrideBackend` lets callers bypass the closure-captured
  /// `recommendation` state. Necessary when the trigger fires
  /// immediately after `recheckOptimalBackend()` resolves — at that
  /// point the `setRecommendation()` from inside the hook has not yet
  /// committed, so the closure here would still see the previous value
  /// (frequently `null`) and bail via the early return.
  ///
  /// The core downloads the build, switches `version_backend` and unloads
  /// the provider's models (`POST /engines/:engine/update`); the dialog
  /// follows the download and switch events that call reports.
  const downloadRecommendedBackend = useCallback(
    async (overrideBackend?: string) => {
      const targetBackend = overrideBackend ?? recommendation?.recommendedBackend
      if (!targetBackend) return

      setRecommendationPhase('downloading')

      try {
        await switchBackendThroughCore(providerId as EngineId, targetBackend)
      } catch (error) {
        console.error('Error downloading recommended backend:', error)
        setRecommendationPhase('recommend')
        throw error
      }
    },
    [recommendation, providerId]
  )

  /// Manual counterpart to the "Find optimal backend" button: a "Latest
  /// <variant>" dropdown pick (`latest/<backend>`) goes to the core, which
  /// switches to the newest build of that variant — downloading it only when
  /// it is not on disk. The global `<BackendUpdater />` dialog opens straight
  /// into its spinner on the pick and follows the same download → switch →
  /// completed progression.
  ///
  /// Rejects with the core's error (the variant cannot be resolved, the
  /// download failed), so the caller can toast.
  const selectManualBackend = useCallback(
    async (selection: string) => {
      const backendId = selection.slice(selection.indexOf('/') + 1).trim()
      const active = useEngineVersionsStore.getState().engines[
        providerId as EngineId
      ]?.active
      events.emit('onManualBackendDownloading', {
        currentBackend: active ? `${active.version}/${active.variant}` : '',
        recommendedBackend: selection,
        recommendedCategory: friendlyBackendLabel(backendId),
        provider: providerId,
        backendId,
      })
      try {
        // A family pick (`latest/win-cuda-12-x64`) names no build the core
        // knows: the extension resolves it against the catalog, and offline
        // to the newest copy on disk.
        const extension = ExtensionManager.getInstance().getByName(
          extensionName
        ) as LlamacppExtension | undefined
        const concrete = extension?.resolveBackendSelection
          ? await extension.resolveBackendSelection(selection)
          : selection
        await switchBackendThroughCore(providerId as EngineId, concrete, {
          announceAs: selection,
        })
      } catch (error) {
        const message = (error as { message?: unknown } | null)?.message
        events.emit('onManualBackendFailed', {
          backend: selection,
          error: typeof message === 'string' ? message : String(error),
          provider: providerId,
          backendId,
        })
        throw error
      }
    },
    [providerId, extensionName]
  )

  /// Tracks whether the post-upgrade auto-recheck has been attempted this
  /// session. Used as a process-local guard on top of the
  /// `WINDOWS_RECHECK_PENDING_KEY` localStorage flag — multiple
  /// `useBackendUpdater()` consumers must not all fire detection in
  /// parallel even within a single tick.
  const postUpgradeRecheckAttemptedRef = useRef(false)

  /// Manual trigger that re-runs hardware detection on the extension side
  /// and surfaces the recommendation dialog when a better backend exists.
  /// Returns the recommendation payload, or `null` when the device is
  /// already on the optimal backend (callers typically toast in that case).
  const recheckOptimalBackend = useCallback(async () => {
    const allExtensions = ExtensionManager.getInstance().listExtensions()
    // Resolve the extension for the selected/default provider. Both llama.cpp
    // providers can be present on every desktop platform. The fallback
    // class-name scan catches bundled tarballs registered under their JS class
    // name instead of the npm package id.
    const primary = ExtensionManager.getInstance().getByName(
      extensionName
    )

    let extensionToUse = primary

    if (!primary) {
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

    if (!extensionToUse || !('recheckOptimalBackend' in extensionToUse)) {
      throw new Error('Extension does not support recheckOptimalBackend')
    }

    const extension = extensionToUse as LlamacppExtension
    const result = await extension.recheckOptimalBackend?.()
    if (result) {
      // Mirror the event payload into local state so the dialog opens
      // immediately even when the Tauri event arrives after the await
      // completes (avoids a perceptible UI lag on the Settings button).
      setRecommendation(result)
      setRecommendationPhase((prev) =>
        prev === 'downloading' || prev === 'restart-required' ? prev : 'recommend'
      )
    }
    return result ?? null
  }, [extensionName])

  /// Manual engine-update check: asks the core about every engine again with
  /// each source re-read (`useEngineVersionsStore.refresh({force})`) and
  /// reports this provider's offer. The core decides — a newer build of
  /// another family or an unstable tag is never offered — and the same answer
  /// feeds the update banner. Rejects with the core's reason when it could not
  /// read this engine's source.
  const checkForEngineUpdate =
    useCallback(async (): Promise<EngineUpdateResult> => {
      await useEngineVersionsStore.getState().refresh({ force: true })
      const { engines, error } = useEngineVersionsStore.getState()
      const entry = engines[providerId as EngineId]
      const failure = entry?.error ?? (entry ? null : error)
      if (failure) throw Object.assign(new Error(failure.message), failure)
      const target = entry?.update.needed ? entry.update.target : null
      return {
        updateAvailable: target !== null,
        targetBackend: target ? `${target.version}/${target.variant}` : null,
      }
    }, [providerId])

  /// Rebuilds the version list from the extension's catalog. An engine update
  /// can install a release that was not in the list registered at load, and
  /// the dropdown would then hold a value with no matching option.
  const refreshBackendCatalog = useCallback(async () => {
    const extensionToUse =
      ExtensionManager.getInstance().getByName(extensionName)
    if (!extensionToUse || !('configureBackends' in extensionToUse)) return
    await (extensionToUse as LlamacppExtension).configureBackends?.()
  }, [extensionName])

  // Post-upgrade Windows auto-recheck.
  //
  // When `windowsProviderMigration` runs in `main.tsx` and detects
  // legacy turboquant footprint on disk (zustand store or
  // `last-used-model` referencing the old `'llamacpp'` provider), it
  // sets the `WINDOWS_RECHECK_PENDING_KEY` flag. We consume that flag
  // here exactly once: poll for the upstream extension to finish its
  // `onLoad()` (extension load happens after React mount, so the
  // extension may not be registered yet on first paint), then call
  // `recheckOptimalBackend()`. The upstream extension's own
  // implementation handles the rest: detect GPU, emit
  // `onBetterBackendDetected`, persist the recommendation; the global
  // `<BackendUpdater />` mounted in `__root.tsx` listens for that
  // event and surfaces the standard download / hot-swap dialog.
  //
  // No-op outside Windows. The flag is cleared even on detection
  // failure to avoid re-prompting on every launch.
  useEffect(() => {
    // Only the default upstream instance runs the post-upgrade auto-recheck;
    // a secondary turboquant instance passes `postUpgradeRecheckEnabled:false`
    // so detection never double-fires on Windows where both providers ship.
    if (!postUpgradeRecheckEnabled) return
    if (!IS_WINDOWS) return
    if (postUpgradeRecheckAttemptedRef.current) return
    let cancelled = false

    const tryRun = async () => {
      try {
        if (localStorage.getItem(WINDOWS_RECHECK_PENDING_KEY) !== '1') return
        postUpgradeRecheckAttemptedRef.current = true
        // Claim the flag immediately so any parallel `useBackendUpdater`
        // instance mounted in the same paint sees a cleared key and
        // bails out on its own read. Without this, multiple components
        // would each run detection on cold boot.
        try {
          localStorage.removeItem(WINDOWS_RECHECK_PENDING_KEY)
        } catch {
          // Non-fatal — second-best scenario is a duplicate prompt.
        }

        // Wait up to ~10s for the extension to register itself with the
        // extension manager. The extension's `onLoad()` is async and
        // can take a noticeable moment on a cold WebView2 boot.
        const start = Date.now()
        while (!cancelled && Date.now() - start < 10_000) {
          const ext = ExtensionManager.getInstance().getByName(
            extensionName
          )
          if (ext && 'recheckOptimalBackend' in ext) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        if (cancelled) return

        try {
          await recheckOptimalBackend()
        } catch (err) {
          console.warn(
            '[useBackendUpdater] post-upgrade recheckOptimalBackend failed:',
            err
          )
        }
      } catch (err) {
        console.warn(
          '[useBackendUpdater] post-upgrade auto-recheck setup failed:',
          err
        )
      }
    }

    void tryRun()

    return () => {
      cancelled = true
    }
  }, [recheckOptimalBackend, postUpgradeRecheckEnabled, extensionName])

  const installBackend = useCallback(async (filePath: string) => {
    try {
      const allExtensions = ExtensionManager.getInstance().listExtensions()
      const llamacppExtension =
        ExtensionManager.getInstance().getByName(extensionName)

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
  }, [extensionName])

  return {
    downloadState,
    recommendation,
    recommendationPhase,
    installBackend,
    dismissRecommendation,
    downloadRecommendedBackend,
    recheckOptimalBackend,
    checkForEngineUpdate,
    refreshBackendCatalog,
    selectManualBackend,
  }
}
