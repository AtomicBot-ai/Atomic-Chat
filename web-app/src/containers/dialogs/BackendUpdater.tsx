import { useBackendUpdater } from '@/hooks/useBackendUpdater'

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

const BackendUpdater = () => {
  const { t } = useTranslation()
  const {
    updateState,
    downloadState,
    recommendation,
    recommendationPhase,
    updateBackend,
    checkForUpdate,
    setRemindMeLater,
    dismissRecommendation,
    downloadRecommendedBackend,
  } = useBackendUpdater()

  useEffect(() => {
    checkForUpdate()
  }, [checkForUpdate])

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

  const handleVersionUpdate = async () => {
    try {
      await updateBackend()
      setRemindMeLater(true)
      toast.success(t('settings:backendUpdater.updateSuccess'))
    } catch (error) {
      console.error('Backend update failed:', error)
      toast.error(t('settings:backendUpdater.updateError'))
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
      const backendType =
        downloadState.backendName.split('/').pop() || downloadState.backendName
      toast.success(
        t('settings:backendUpdater.downloadComplete', { backend: backendType })
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

  const showRecommendationDialog =
    recommendationPhase === 'recommend' ||
    recommendationPhase === 'downloading' ||
    recommendationPhase === 'hotswapping' ||
    recommendationPhase === 'restart-required'

  const showVersionUpdateToast =
    !showRecommendationDialog &&
    updateState.isUpdateAvailable &&
    !updateState.remindMeLater

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

      {/* Version update toast (existing flow, separate from GPU recommendation) */}
      {showVersionUpdateToast && (
        <div className="fixed z-50 bottom-3 right-3 bg-background flex items-center border rounded-lg shadow-md">
          <div className="px-2 py-4">
            <div className="px-4">
              <div className="flex items-start gap-2">
                <IconDownload
                  size={20}
                  className="shrink-0 text-muted-foreground mt-1"
                />
                <div>
                  <div className="text-base font-medium">
                    {t('settings:backendUpdater.newBackendVersion', {
                      version: updateState.updateInfo?.newVersion,
                    })}
                  </div>
                  <div className="mt-1 text-muted-foreground font-normal mb-2">
                    {t('settings:backendUpdater.backendUpdateAvailable')}
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-3 px-4">
              <div className="flex gap-x-4 w-full items-center justify-end">
                <div className="flex gap-x-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemindMeLater(true)}
                  >
                    {t('settings:backendUpdater.remindMeLater')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleVersionUpdate}
                    disabled={updateState.isUpdating}
                  >
                    {updateState.isUpdating
                      ? t('settings:backendUpdater.updating')
                      : t('settings:backendUpdater.updateNow')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default BackendUpdater
