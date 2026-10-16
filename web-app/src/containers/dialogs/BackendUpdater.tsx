import {
  useBackendUpdater,
  type UseBackendUpdaterConfig,
} from '@/hooks/useBackendUpdater'

import {
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconX,
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

import { useEffect } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toast } from 'sonner'
import { getProviderTitle, LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'

/// Progress-only view onto the turboquant provider. The recommendation modal
/// stays upstream-owned so two providers can never argue over the same dialog,
/// but `reconcileBackendReleaseTag()` starts a download on its own after an app
/// update — sometimes several hundred megabytes — and that must not happen
/// invisibly.
const TURBOQUANT_PROGRESS_CONFIG: UseBackendUpdaterConfig = {
  extensionName: '@janhq/llamacpp-extension',
  providerId: 'llamacpp',
  recommendationKey: 'turboquant_better_backend_recommendation',
  postUpgradeRecheckEnabled: false,
}

/// Renders a `<tag>/<backend-id>` pair for humans. The id alone (`macos-arm64`,
/// `win-cuda-13.3-x64`) says nothing about which release is landing, and the
/// release tag is the whole point of an unattended engine update.
const backendLabel = (backendName: string | null | undefined): string => {
  if (!backendName) return ''
  const [version, backendId] = backendName.split('/')
  return backendId ? `${backendId} (${version})` : backendName
}

const BackendUpdater = () => {
  const { t } = useTranslation()
  const {
    downloadState,
    recommendation,
    recommendationPhase,
    dismissRecommendation,
    downloadRecommendedBackend,
  } = useBackendUpdater()

  const { downloadState: turboquantDownload } = useBackendUpdater(
    TURBOQUANT_PROGRESS_CONFIG
  )

  const handleRestart = async () => {
    try {
      await window.core?.api?.relaunch()
    } catch (error) {
      console.error('Failed to relaunch:', error)
    }
  }

  const handleDownloadRecommended = async () => {
    try {
      await downloadRecommendedBackend()
    } catch (error) {
      console.error('Recommended backend download failed:', error)
      toast.error(t('settings:backendUpdater.downloadFailed'))
    }
  }

  // Show toast on non-recommendation download completion. We deliberately
  // skip the toast when the recommendation flow is in progress because the
  // compact dialog already surfaces downloading/hot-swapping. Completion uses
  // the dedicated success toast below; restart-required remains a dialog.
  useEffect(() => {
    if (
      downloadState.status === 'completed' &&
      downloadState.backendName &&
      recommendationPhase !== 'restart-required' &&
      recommendationPhase !== 'hotswapping' &&
      recommendationPhase !== 'completed'
    ) {
      toast.success(
        t('settings:backendUpdater.downloadComplete', {
          backend: backendLabel(downloadState.backendName),
        })
      )
    } else if (
      downloadState.status === 'failed' &&
      recommendationPhase !== 'downloading' &&
      recommendationPhase !== 'recommend'
    ) {
      toast.error(t('settings:backendUpdater.downloadFailed'))
    }
  }, [downloadState.status, downloadState.backendName, recommendationPhase, t])

  /// Surface a single success toast when the live hot-swap completes.
  /// Guarded against repeated firing because `recommendationPhase ===
  /// 'completed'` is a transient state that the hook auto-dismisses
  /// after ~1.5s, so the effect runs exactly once per swap.
  useEffect(() => {
    if (recommendationPhase === 'completed') {
      toast.success(t('settings:backendUpdater.hotSwapSuccess'))
    }
  }, [recommendationPhase, t])

  /// The turboquant reconcile runs unattended, so its outcome only ever
  /// reaches the user through these toasts.
  useEffect(() => {
    if (turboquantDownload.status === 'completed' && turboquantDownload.backendName) {
      toast.success(
        t('settings:backendUpdater.downloadComplete', {
          backend: backendLabel(turboquantDownload.backendName),
        })
      )
    } else if (turboquantDownload.status === 'failed') {
      toast.error(t('settings:backendUpdater.downloadFailed'))
    }
  }, [turboquantDownload.status, turboquantDownload.backendName, t])

  const showRecommendationDialog =
    recommendationPhase === 'recommend' ||
    recommendationPhase === 'downloading' ||
    recommendationPhase === 'hotswapping' ||
    recommendationPhase === 'restart-required'

  /// Both providers download without being asked: each reconciles its release
  /// tag after an app update, and upstream additionally applies the tier that
  /// startup detection picked for this host. Anything the user started himself
  /// is already on screen in the dialog above, so this banner is the only thing
  /// that tells him the rest is moving.
  const backgroundDownload = showRecommendationDialog
    ? null
    : downloadState.isDownloading
      ? downloadState
      : turboquantDownload.isDownloading
        ? turboquantDownload
        : null

  const backgroundBackendLabel = backendLabel(backgroundDownload?.backendName)

  return (
    <>
      {/* GPU backend recommendation dialog */}
      <Dialog
        open={showRecommendationDialog}
        onOpenChange={(open) => {
          if (!open && recommendationPhase === 'recommend') {
            dismissRecommendation()
          }
        }}
      >
        <DialogContent
          className="gap-4 p-4 sm:max-w-[18rem]"
          showCloseButton={recommendationPhase === 'recommend'}
          onInteractOutside={(e) => {
            if (recommendationPhase !== 'recommend') {
              e.preventDefault()
            }
          }}
        >
          {recommendationPhase === 'recommend' && recommendation && (
            <div className="flex flex-col gap-3">
              <DialogHeader className="gap-1 pr-6 text-left">
                <DialogTitle className="text-base leading-5">
                  {t('settings:backendUpdater.betterBackendTitle')}
                </DialogTitle>
                <DialogDescription className="text-xs leading-5">
                  {t('settings:backendUpdater.betterBackendDesc', {
                    backend: recommendation.recommendedCategory,
                  })}
                </DialogDescription>
                {/* Both llama providers can recommend a different backend for
                    the same GPU, so name the one this dialog speaks for. */}
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {t('settings:backendUpdater.betterBackendProviderContext', {
                    provider: getProviderTitle(
                      recommendation.provider ?? LOCAL_LLAMACPP_PROVIDER
                    ),
                    backend:
                      recommendation.backendId ??
                      recommendation.recommendedBackend,
                  })}
                </p>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  onClick={dismissRecommendation}
                  className="h-10"
                >
                  <IconX size={16} className="mr-1" />
                  {t('settings:backendUpdater.notNow')}
                </Button>
                <Button
                  onClick={handleDownloadRecommended}
                  className="h-10"
                >
                  <IconDownload size={16} className="mr-1" />
                  {t('settings:backendUpdater.downloadNow')}
                </Button>
              </div>
            </div>
          )}

          {recommendationPhase === 'downloading' && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t('settings:backendUpdater.downloadingBackend')}
                </DialogTitle>
                <DialogDescription>
                  {t('settings:backendUpdater.downloadingBackendDesc')}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center py-2">
                <IconLoader2 size={24} className="text-blue-500 animate-spin" />
              </div>
            </>
          )}

          {recommendationPhase === 'hotswapping' && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t('settings:backendUpdater.hotSwapping')}
                </DialogTitle>
                <DialogDescription>
                  {t('settings:backendUpdater.hotSwappingDesc', {
                    backend:
                      recommendation?.recommendedCategory ??
                      recommendation?.recommendedBackend ??
                      '',
                  })}
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center justify-center py-2">
                <IconLoader2 size={24} className="text-blue-500 animate-spin" />
              </div>
            </>
          )}

          {recommendationPhase === 'restart-required' && (
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

      {/* Unattended backend download — non-blocking progress */}
      {backgroundDownload && (
        <div className="fixed z-50 bottom-3 right-3 bg-background flex items-start gap-2 border rounded-lg shadow-md px-4 py-3 max-w-[22rem]">
          <IconLoader2
            size={18}
            className="shrink-0 text-blue-500 animate-spin mt-0.5"
          />
          <div>
            <div className="text-sm font-medium">
              {t('settings:backendUpdater.backgroundUpdateTitle')}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t('settings:backendUpdater.backgroundUpdateDesc', {
                backend: backgroundBackendLabel,
              })}
            </div>
          </div>
        </div>
      )}

    </>
  )
}

export default BackendUpdater
