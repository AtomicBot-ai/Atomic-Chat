import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconRefresh,
  IconRocket,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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
 * still goes through while this overlays it. One provider-agnostic dialog serves
 * both llama.cpp providers — the provider comes from the recorded event, and the
 * fix runs through the already-debugged `useBackendUpdater`
 * detect -> download -> hot-swap path.
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

  // A GPU build that ended up on the CPU needs stack-specific advice: the CUDA
  // runtime is a separate install, while Vulkan comes from the graphics driver.
  // The CUDA wording asserts a missing runtime, so it stays gated on the probe
  // that actually established that; the Vulkan wording only suggests a cause.
  const runtimeHint = (() => {
    if (mismatch?.kind !== 'runtime-cpu') return null
    if (mismatch.cudaRuntimeMissing)
      return t('settings:backendMismatch.cudaRuntimeHint')
    if (mismatch.gpuKind === 'vulkan')
      return t('settings:backendMismatch.vulkanDriverHint')
    return null
  })()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) setOpen(false)
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        onInteractOutside={(e) => {
          if (busy) e.preventDefault()
        }}
      >
        {view === 'prompt' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <IconAlertTriangle size={18} className="text-amber-500" />
                {title}
              </DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            {runtimeHint && (
              <p className="text-sm text-main-view-fg/70">{runtimeHint}</p>
            )}
            <DialogFooter>
              <Button variant="link" onClick={handleDontRemind}>
                {t('settings:backendMismatch.dontRemind')}
              </Button>
              <Button variant="outline" onClick={handleLater}>
                {t('settings:backendMismatch.later')}
              </Button>
              <Button onClick={handleFix}>
                <IconRocket size={16} className="mr-1" />
                {t('settings:backendMismatch.fix')}
              </Button>
            </DialogFooter>
          </>
        )}

        {busy && (
          <>
            <DialogHeader>
              <DialogTitle>
                {recommendationPhase === 'completed'
                  ? t('settings:backendUpdater.hotSwapSuccess')
                  : recommendationPhase === 'hotswapping'
                    ? t('settings:backendUpdater.hotSwapping')
                    : t('settings:backendUpdater.downloadingBackend')}
              </DialogTitle>
              <DialogDescription>
                {recommendationPhase === 'completed'
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
                    : t('settings:backendUpdater.downloadingBackendDesc')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center justify-center py-4">
              {recommendationPhase === 'completed' ? (
                <IconCheck size={32} className="text-emerald-500" />
              ) : (
                <IconLoader2 size={32} className="text-blue-500 animate-spin" />
              )}
            </div>
          </>
        )}

        {restartRequired && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('settings:backendUpdater.restartRequired')}
              </DialogTitle>
              <DialogDescription>
                {t('settings:backendUpdater.restartRequiredDesc')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={handleRestart}>
                <IconRefresh size={16} className="mr-1" />
                {t('settings:backendUpdater.restartNow')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default SuboptimalBackendDialog
