import { memo, useMemo } from 'react'
import { IconCircleCheckFilled, IconDownload, IconKey } from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { route } from '@/constants/routes'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { planArtifactDownload } from '@/lib/diffusion/models'
import { formatBytes } from '@/lib/downloadFormat'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'

type ImageDownloadPlanDialogProps = {
  /** `<family>:<quantId>` to plan for; the dialog is open while non-null. */
  artifactId: string | null
  onOpenChange: (open: boolean) => void
}

/**
 * What a checkpoint download will actually fetch.
 *
 * A family is a transformer plus side files (VAE, text encoders), and the side
 * files are shared between families — the Qwen3 encoder serves both Z-Image
 * and FLUX.2 klein — so "download" can mean 2 GB or 12 GB depending on what
 * is already on disk. The plan lists every file with its present/missing
 * state and totals only the missing bytes, so the number on the button is the
 * number that will move.
 */
export const ImageDownloadPlanDialog = memo(function ImageDownloadPlanDialog({
  artifactId,
  onOpenChange,
}: ImageDownloadPlanDialogProps) {
  const { t } = useTranslation()
  const artifact = useImageArtifact(artifactId ?? '')
  const modelFiles = useImageGenerationStore((state) => state.modelFiles)
  const paths = useImageGenerationStore((state) => state.paths)
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const plan = useMemo(() => {
    if (!artifact.family || !artifact.quant || !paths) return null
    return planArtifactDownload(
      artifact.family,
      artifact.quant.id,
      modelFiles,
      paths.modelsRoot
    )
  }, [artifact.family, artifact.quant, modelFiles, paths])

  const gated = Boolean(artifact.family?.gated) && !huggingfaceToken
  const open = artifactId !== null

  const start = () => {
    void artifact.download()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('images:plan.title', {
              name: artifact.family?.name ?? '',
              quant: artifact.quant?.label ?? '',
            })}
          </DialogTitle>
          <DialogDescription>{t('images:plan.description')}</DialogDescription>
        </DialogHeader>

        {plan && (
          <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="plan-entries">
            {plan.entries.map((entry) => (
              <li
                key={entry.savePath}
                className="flex items-center gap-3 rounded-md border bg-secondary/40 px-3 py-2"
                data-present={entry.present ? 'true' : 'false'}
              >
                <span
                  className={cn(
                    'shrink-0',
                    entry.present
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-muted-foreground'
                  )}
                >
                  {entry.present ? (
                    <IconCircleCheckFilled size={16} />
                  ) : (
                    <IconDownload size={16} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={entry.filename}>
                    {entry.filename}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {t(`images:plan.kind.${entry.kind}`)}
                    <span className="mx-1.5 text-muted-foreground/50">·</span>
                    <span className="truncate">{entry.repo}</span>
                  </p>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {entry.present
                    ? t('images:plan.present')
                    : t('images:plan.sizeGb', {
                        size: formatBytes(entry.bytes, 1024 ** 3),
                      })}
                </span>
              </li>
            ))}
          </ul>
        )}

        {plan && (
          <p className="text-sm" data-testid="plan-total">
            {t('images:plan.total', {
              missing: formatBytes(plan.missingBytes, 1024 ** 3),
              total: formatBytes(plan.totalBytes, 1024 ** 3),
            })}
          </p>
        )}

        {gated && (
          <div className="flex items-start gap-2 rounded-md border bg-secondary p-3 text-xs">
            <IconKey size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground">
              {t('images:plan.gatedHint')}{' '}
              <Link
                to={route.settings.general}
                className="underline"
                onClick={() => onOpenChange(false)}
              >
                {t('images:plan.gatedLink')}
              </Link>
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!plan || plan.missingBytes === 0 && plan.entries.every((e) => e.present)}
            onClick={start}
            data-testid="plan-download"
          >
            <IconDownload size={16} />
            {t('images:plan.download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default ImageDownloadPlanDialog
