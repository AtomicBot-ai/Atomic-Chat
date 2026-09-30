import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { AppEvent, events } from '@janhq/core'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { route } from '@/constants/routes'
import { ModelLogo } from '@/containers/ModelLogo'
import { RouteRow } from '@/containers/RouteRow'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useVisionDownloads } from '@/hooks/useVisionDownloads'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cancelDownload } from '@/lib/downloadCancellation'
import { formatDownloadReadout } from '@/lib/downloadFormat'
import { HUGGINGFACE_LOGO_SRC } from '@/lib/model-logo'

/** How long the list may take to resolve before the dialog stops waiting. */
const RESOLVE_WAIT_MS = 8_000

type VisionModelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Display name of the model in use; empty when none is selected. */
  modelName: string
  /**
   * A vision model can take the thread over: one this dialog started
   * downloading has been imported, or one already on disk was chosen. The
   * composer switches to it and marks it as seeing.
   */
  onModelReady: (modelId: string) => void
}

/**
 * "This model can't see images" — asked the moment an image is attached to a
 * text-only model.
 *
 * Replaces a corner popover that named one hard-coded model and said nothing
 * about why: a user who has never heard of a vision model read it as an ad.
 * This says what is wrong in plain words and lists the vision models this
 * machine can run, each a download away (`useVisionDownloads`), with the rest
 * of Hugging Face behind them.
 *
 * The import listener lives in the always-mounted shell, not the body: the
 * user may close the dialog while the download runs — it is minutes long —
 * and the switch has to happen when the model lands, not only if the dialog
 * is still up.
 */
export function VisionModelDialog({
  open,
  onOpenChange,
  modelName,
  onModelReady,
}: VisionModelDialogProps) {
  const startedRef = useRef<string | null>(null)
  const onModelReadyRef = useRef(onModelReady)
  useEffect(() => {
    onModelReadyRef.current = onModelReady
  }, [onModelReady])

  useEffect(() => {
    const handleModelImported = (data?: { modelId?: string }) => {
      const modelId = data?.modelId
      if (!modelId || modelId !== startedRef.current) return
      startedRef.current = null
      onModelReadyRef.current(modelId)
    }
    events.on(AppEvent.onModelImported, handleModelImported)
    return () => {
      events.off(AppEvent.onModelImported, handleModelImported)
    }
  }, [])

  const handleDownloadStarted = useCallback((modelId: string) => {
    startedRef.current = modelId
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-x-hidden sm:max-w-lg lg:max-w-lg xl:max-w-lg">
        {open && (
          <VisionModelDialogBody
            modelName={modelName}
            onDownloadStarted={handleDownloadStarted}
            onUse={onModelReady}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The dialog's contents.
 *
 * Split out so it mounts only while the dialog is open: it resolves model
 * cards from Hugging Face, and those requests have no business firing on
 * every composer render.
 */
function VisionModelDialogBody({
  modelName,
  onDownloadStarted,
  onUse,
  onClose,
}: {
  modelName: string
  onDownloadStarted: (modelId: string) => void
  onUse: (modelId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const { items, isLoading } = useVisionDownloads()
  const downloads = useDownloadStore((state) => state.downloads)
  const pausedDownloads = useDownloadStore((state) => state.pausedDownloads)
  // The card lookup has no failure state of its own; past this the empty
  // line and the Hub row are the offer.
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (!isLoading || gaveUp) return
    const timer = setTimeout(() => setGaveUp(true), RESOLVE_WAIT_MS)
    return () => clearTimeout(timer)
  }, [isLoading, gaveUp])

  const downloadFor = (modelId: string) => {
    const entry = Object.values(downloads).find((d) => d.id === modelId)
    if (!entry) return null
    return {
      ...entry,
      bytesPerSecond: entry.speed?.bytesPerSecond ?? 0,
      paused: pausedDownloads.has(modelId),
    }
  }

  const handleBrowseHub = () => {
    onClose()
    void navigate({ to: route.hub.index })
  }

  const title = modelName
    ? t('chat:visionGate.title', { model: modelName })
    : t('chat:visionGate.titleNoModel')

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {t('chat:visionGate.description')}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {t('chat:visionGate.sectionLabel')}
        </span>

        {items.length === 0 ? (
          <div
            className="flex items-center gap-3 rounded-lg border bg-secondary/50 p-3"
            data-testid="vision-gate-recommended"
          >
            {isLoading && !gaveUp ? (
              <>
                <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
                <span className="text-muted-foreground truncate text-sm">
                  {t('chat:visionGate.finding')}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground text-sm">
                {t('chat:visionGate.empty')}
              </span>
            )}
          </div>
        ) : (
          <div
            className="min-w-0 overflow-x-hidden rounded-lg border bg-secondary/50 px-3 py-2"
            data-testid="vision-gate-recommended"
          >
            <div className="flex flex-col divide-y divide-border/60">
              {items.map((item, index) => {
                const activeDownload = item.isDownloading
                  ? downloadFor(item.variant.model_id)
                  : null
                const reason = `${t('chat:visionGate.visionCapable')} · ${t(item.hint)}`
                const hint = item.installed
                  ? t('chat:visionGate.installedHint')
                  : item.isDownloading
                    ? activeDownload
                      ? formatDownloadReadout(t, activeDownload)
                      : t('chat:visionGate.downloading')
                    : item.sizeLabel
                      ? t('chat:visionGate.rowHint', {
                          size: item.sizeLabel,
                          reason,
                        })
                      : reason
                return (
                  <RouteRow
                    key={item.repo}
                    icon={
                      // Through `ModelLogo` so single-color marks (Liquid's
                      // LFM among them) are tinted and survive a dark background.
                      <ModelLogo
                        name={item.repo}
                        icon={item.icon}
                        fallback="huggingface"
                        className="size-8 rounded-full border-0 bg-transparent dark:bg-transparent"
                      />
                    }
                    title={item.title}
                    hint={hint}
                    action={
                      item.installed
                        ? t('chat:visionGate.use')
                        : item.isDownloading
                          ? t('common:cancel')
                          : t('chat:visionGate.download')
                    }
                    label={
                      item.installed
                        ? t('chat:visionGate.useLabel', { name: item.title })
                        : item.isDownloading
                          ? t('common:cancelDownload')
                          : t('chat:visionGate.downloadLabel', {
                              name: item.title,
                            })
                    }
                    primary={index === 0}
                    textAction={item.isDownloading}
                    onClick={() => {
                      if (item.installed) {
                        onUse(item.variant.model_id)
                        return
                      }
                      if (item.isDownloading) {
                        cancelDownload(
                          {
                            id: item.variant.model_id,
                            name: item.variant.model_id,
                          },
                          serviceHub
                        )
                        return
                      }
                      const started = item.start()
                      if (!started) return
                      onDownloadStarted(started)
                      onClose()
                    }}
                    data-testid={
                      index === 0
                        ? 'vision-gate-recommended-lead'
                        : 'vision-gate-recommended-other'
                    }
                  />
                )
              })}
            </div>
          </div>
        )}

        <div
          className="min-w-0 overflow-x-hidden rounded-lg border bg-secondary/50 px-3 py-2"
          data-testid="vision-gate-routes"
        >
          <RouteRow
            icon={<img src={HUGGINGFACE_LOGO_SRC} alt="" />}
            title={t('chat:visionGate.huggingFaceTitle')}
            hint={t('chat:visionGate.huggingFaceHint')}
            action={t('chat:visionGate.browse')}
            label={t('chat:visionGate.huggingFaceLabel')}
            onClick={handleBrowseHub}
            data-testid="vision-gate-browse-hub"
          />
        </div>
      </div>

    </>
  )
}
