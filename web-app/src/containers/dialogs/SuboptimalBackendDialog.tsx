import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  IconBolt,
  IconCheck,
  IconLoader2,
  IconRefresh,
  IconRocket,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'

import {
  useBackendUpdater,
  type UseBackendUpdaterConfig,
} from '@/hooks/useBackendUpdater'
import {
  BACKEND_MISMATCH_PROMPT_EVENT,
  useBackendMismatch,
} from '@/hooks/useBackendMismatch'
import {
  getProviderTitle,
  LOCAL_LLAMACPP_EXTENSION_NAME,
  LOCAL_LLAMACPP_PROVIDER,
} from '@/lib/utils'

const BACKEND_DETECTION_FAILED = 'BACKEND_DETECTION_FAILED'

const TURBOQUANT_CONFIG: UseBackendUpdaterConfig = {
  extensionName: '@janhq/llamacpp-extension',
  providerId: 'llamacpp',
  recommendationKey: 'turboquant_better_backend_recommendation',
  postUpgradeRecheckEnabled: false,
}

const UPSTREAM_CONFIG: UseBackendUpdaterConfig = {
  extensionName: LOCAL_LLAMACPP_EXTENSION_NAME,
  providerId: LOCAL_LLAMACPP_PROVIDER,
  recommendationKey: 'llama_cpp_better_backend_recommendation',
  postUpgradeRecheckEnabled: false,
}

/**
 * Tells the user when the model is not running on the backend the UI shows, and
 * offers the one-click fix.
 *
 * Mounted globally in `__root.tsx`. The mismatch is detected at model load and
 * recorded in `useBackendMismatch`; `ChatInput` dispatches
 * `BACKEND_MISMATCH_PROMPT_EVENT` on the first send afterwards so the message
 * still goes through while the non-blocking prompt appears in the lower-right
 * corner. One provider-agnostic dialog serves both llama.cpp providers — the
 * provider comes from the recorded event, and the fix runs through the
 * already-debugged `useBackendUpdater` detect -> download -> hot-swap path.
 */
const SuboptimalBackendDialog = () => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'prompt' | 'working'>('prompt')
  const { pending, markShown, suppress, dismiss } = useBackendMismatch()

  const config = useMemo<UseBackendUpdaterConfig>(
    () =>
      pending?.provider === 'llamacpp' ? TURBOQUANT_CONFIG : UPSTREAM_CONFIG,
    [pending?.provider]
  )

  const {
    recommendation,
    recommendationPhase,
    recheckOptimalBackend,
    downloadRecommendedBackend,
  } = useBackendUpdater(config)

  useEffect(() => {
    const handler = () => {
      markShown()
      setView('prompt')
      setOpen(true)
    }
    window.addEventListener(BACKEND_MISMATCH_PROMPT_EVENT, handler)
    return () =>
      window.removeEventListener(BACKEND_MISMATCH_PROMPT_EVENT, handler)
  }, [markShown])

  useEffect(() => {
    if (view === 'working' && recommendationPhase === 'completed') {
      toast.success(t('settings:backendUpdater.hotSwapSuccess'))
      const timer = setTimeout(() => setOpen(false), 1500)
      return () => clearTimeout(timer)
    }
  }, [view, recommendationPhase, t])

  const handleLater = useCallback(() => setOpen(false), [])

  const handleDontRemind = useCallback(() => {
    suppress()
    dismiss()
    setOpen(false)
  }, [suppress, dismiss])

  const handleFix = useCallback(async () => {
    setView('working')
    try {
      const result = await recheckOptimalBackend()
      if (!result) {
        toast.success(t('settings:backendUpdater.alreadyOptimal'))
        dismiss()
        setOpen(false)
        return
      }
      await downloadRecommendedBackend(result.recommendedBackend)
      dismiss()
    } catch (error) {
      if (error instanceof Error && error.message === BACKEND_DETECTION_FAILED) {
        toast.info(t('settings:backendUpdater.detectionUnavailable'))
      } else {
        console.error('Backend mismatch fix failed:', error)
        toast.error(t('settings:backendUpdater.downloadFailed'))
      }
      setOpen(false)
    }
  }, [recheckOptimalBackend, downloadRecommendedBackend, dismiss, t])

  const handleRestart = useCallback(async () => {
    try {
      await window.core?.api?.relaunch()
    } catch (error) {
      console.error('Failed to relaunch:', error)
    }
  }, [])

  const busy =
    view === 'working' &&
    (recommendationPhase === 'recommend' ||
      recommendationPhase === 'downloading' ||
      recommendationPhase === 'hotswapping' ||
      recommendationPhase === 'completed')

  const restartRequired =
    view === 'working' && recommendationPhase === 'restart-required'

  const mismatch = pending?.mismatch

  const title = (() => {
    switch (mismatch?.kind) {
      case 'runtime-cpu':
        return t('settings:backendMismatch.runtimeCpuTitle')
      case 'silent-fallback':
        return t('settings:backendMismatch.silentFallbackTitle')
      default:
        return t('settings:backendMismatch.suboptimalTitle')
    }
  })()

  const description = (() => {
    switch (mismatch?.kind) {
      case 'runtime-cpu':
        return mismatch.total
          ? t('settings:backendMismatch.runtimeCpuDescLayers', {
              configured: mismatch.configured,
              offloaded: mismatch.offloaded ?? 0,
              total: mismatch.total,
            })
          : t('settings:backendMismatch.runtimeCpuDesc', {
              configured: mismatch.configured,
              device: mismatch.primaryDevice,
            })
      case 'silent-fallback':
        return t('settings:backendMismatch.silentFallbackDesc', {
          configured: mismatch.configured,
          effective: mismatch.effective,
        })
      case 'suboptimal-config':
        return t('settings:backendMismatch.suboptimalDesc', {
          configured: mismatch.configured,
          ideal: mismatch.ideal,
        })
      default:
        return ''
    }
  })()

  // A GPU build that ended up on the CPU needs stack-specific advice: CUDA and
  // ROCm runtimes are separate installs, while Vulkan comes from the graphics
  // driver. The CUDA wording asserts a missing runtime, so it stays gated on
  // the probe that actually established that; the others suggest a cause.
  const runtimeHint = (() => {
    if (mismatch?.kind !== 'runtime-cpu') return null
    if (mismatch.cudaRuntimeMissing)
      return t('settings:backendMismatch.cudaRuntimeHint')
    if (mismatch.gpuKind === 'rocm')
      return t('settings:backendMismatch.rocmRuntimeHint')
    if (mismatch.gpuKind === 'vulkan')
      return t('settings:backendMismatch.vulkanDriverHint')
    return null
  })()

  if (!open) return null

  const workingTitle =
    recommendationPhase === 'completed'
      ? t('settings:backendUpdater.hotSwapSuccess')
      : recommendationPhase === 'hotswapping'
        ? t('settings:backendUpdater.hotSwapping')
        : t('settings:backendUpdater.downloadingBackend')

  const workingDescription =
    recommendationPhase === 'completed'
      ? t('settings:backendUpdater.hotSwapSuccessDesc', {
          backend:
            recommendation?.recommendedCategory ??
            recommendation?.recommendedBackend ??
            '',
        })
      : recommendationPhase === 'hotswapping'
        ? t('settings:backendUpdater.hotSwappingDesc', {
            backend:
              recommendation?.recommendedCategory ??
              recommendation?.recommendedBackend ??
              '',
          })
        : t('settings:backendUpdater.downloadingBackendDesc')

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-live="polite"
      aria-label={view === 'prompt' ? title : workingTitle}
      className="fixed right-3 bottom-3 z-50 w-[min(26rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border bg-background shadow-xl outline-none animate-in fade-in-0 slide-in-from-bottom-3 duration-200"
    >
      {view === 'prompt' && (
        <>
          <div className="flex items-start gap-3 p-4 pr-11">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <IconBolt size={19} stroke={1.8} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold leading-5 text-foreground">
                {title}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {description}
              </p>
              {runtimeHint && (
                <p className="mt-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs leading-4 text-muted-foreground">
                  {runtimeHint}
                </p>
              )}
              {/* Name the provider and release the verdict is about: the two
                  llama providers reach different optimal backends on the same
                  machine, so an unattributed notice is ambiguous. */}
              {pending && (
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                  {t('settings:backendUpdater.betterBackendProviderContext', {
                    provider: getProviderTitle(pending.provider),
                    backend: pending.configuredVersionBackend,
                  })}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-3 right-3 text-muted-foreground"
              onClick={handleLater}
              aria-label={t('settings:backendMismatch.later')}
            >
              <IconX />
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3 border-t bg-muted/20 px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-muted-foreground"
              onClick={handleDontRemind}
            >
              {t('settings:backendMismatch.dontRemind')}
            </Button>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="w-24"
                onClick={handleLater}
              >
                {t('settings:backendMismatch.later')}
              </Button>
              <Button size="sm" className="w-24" onClick={handleFix}>
                <IconRocket />
                {t('settings:backendMismatch.fix')}
              </Button>
            </div>
          </div>
        </>
      )}

      {busy && (
        <div className="relative flex items-start gap-3 p-4">
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
              recommendationPhase === 'completed'
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
            }`}
          >
            {recommendationPhase === 'completed' ? (
              <IconCheck size={20} stroke={2} />
            ) : (
              <IconLoader2 size={20} className="animate-spin" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-5">{workingTitle}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {workingDescription}
            </p>
          </div>
          {recommendationPhase !== 'completed' && (
            <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-blue-500/15">
              <div className="h-full w-1/2 animate-pulse rounded-full bg-blue-500" />
            </div>
          )}
        </div>
      )}

      {restartRequired && (
        <>
          <div className="flex items-start gap-3 p-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <IconRefresh size={19} stroke={1.8} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold leading-5">
                {t('settings:backendUpdater.restartRequired')}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t('settings:backendUpdater.restartRequiredDesc')}
              </p>
            </div>
          </div>
          <div className="flex justify-end border-t bg-muted/20 px-4 py-3">
            <Button size="sm" onClick={handleRestart}>
              <IconRefresh />
              {t('settings:backendUpdater.restartNow')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

export default SuboptimalBackendDialog
