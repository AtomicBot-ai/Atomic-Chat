import { useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconExternalLink, IconTrash, IconX } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ModelLogo } from '@/containers/ModelLogo'
import { route } from '@/constants/routes'
import { useAudioModel } from '@/hooks/useAudioModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, formatBytes } from '@/lib/utils'
import type { AudioCatalogModel } from '@/services/audio-catalog-registry'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

export type AudioModelDetailPanelProps = {
  model: AudioCatalogModel
  className?: string
}

/**
 * An audio model's details below its Hub row: what it makes, its file with
 * Download, the download's progress, or — once on disk — Open, which takes
 * the Audios studio to the model's mode with the model picked. The same
 * `useAudioModel` state as the studio's model list, so the two agree on
 * progress and removals.
 */
export function AudioModelDetailPanel({
  model,
  className,
}: AudioModelDetailPanelProps) {
  const { t } = useTranslation()
  const durations = model.ranges?.durationSec

  return (
    <div
      className={cn('flex flex-col gap-4 p-6', className)}
      data-testid={`audio-model-panel-${model.id}`}
    >
      <header className="flex items-start gap-3">
        <ModelLogo
          icon={model.icon}
          name={model.name}
          author={model.developer}
        />
        <div className="min-w-0 flex-1">
          <h1
            className="min-w-0 truncate text-xl font-semibold"
            title={model.name}
          >
            {model.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {model.developer}
          </p>
        </div>
        <a
          href={`https://huggingface.co/${model.repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0"
        >
          <Button variant="outline" size="sm" className="gap-1.5">
            <IconExternalLink size={14} />
            {t('hub:openOnWeb')}
          </Button>
        </a>
      </header>

      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{model.description}</p>
        {model.attribution && (
          <p
            className="text-[11px] leading-3 text-muted-foreground"
            data-testid="audio-attribution"
          >
            {model.attribution}
          </p>
        )}
      </div>

      <AudioDownloadOptions model={model} />

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:details')}</h2>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <DetailCell label={t('audios:mode.choose')}>
            {t(`audios:mode.${model.mode}.title`)}
          </DetailCell>
          <DetailCell label={t('hub:license')}>{model.license}</DetailCell>
          {durations && (
            <DetailCell label={t('hub:audioLength')}>
              {t('hub:audioLengthRange', {
                min: durations[0],
                max: durations[1],
              })}
            </DetailCell>
          )}
        </dl>
      </section>
    </div>
  )
}

function DetailCell({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="rounded-md bg-muted/40 p-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold text-foreground">
        {children}
      </dd>
    </div>
  )
}

/**
 * The file the studio downloads and runs (the catalog's recommended quant),
 * with its size, then one action slot: Download, its progress with cancel,
 * or Open; the remove button follows once the file is on disk.
 */
function AudioDownloadOptions({ model }: { model: AudioCatalogModel }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const state = useAudioModel(model)
  const core = useAudioGenerationStore((s) => s.core)
  const engineInstalled = useAudioGenerationStore(
    (s) => s.status?.install.state === 'installed'
  )
  const hostBackendId = useAudioGenerationStore((s) => s.hostBackendId)
  const hostBackendResolved = useAudioGenerationStore(
    (s) => s.hostBackendResolved
  )
  const [confirmRemove, setConfirmRemove] = useState(false)

  const canDownload =
    core === 'ready' && (engineInstalled || hostBackendId !== null)
  // Said once the core has answered, so a list still asking does not flash it.
  const unavailable =
    !canDownload &&
    (core === 'too-old' ||
      core === 'unreachable' ||
      (core === 'ready' && hostBackendResolved))
  const percent = Math.round(state.progress * 100)
  const openLabel = t('hub:openInAudios')

  // Picking the model here is what makes the studio open on it, the same
  // selection a download from the studio's own list records.
  const download = () => {
    useAudioGenerationStore.getState().pickModel(model.id)
    void state.download()
  }

  const openInAudios = () => {
    const store = useAudioGenerationStore.getState()
    store.setMode(model.mode)
    store.pickModel(model.id)
    void navigate({ to: route.audios.index })
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
        data-testid={`audio-quant-${model.id}`}
      >
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-md bg-muted/40 px-2 py-2">
          <span className="shrink-0 rounded-[5px] bg-secondary px-[7px] py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
            {state.quant.label}
          </span>
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            {formatBytes(state.quant.bytes)}
          </span>
        </div>
        {/* One action column in every state: Download, its progress and Open
            share the w-24 slot, and the remove slot is held even when empty. */}
        <span
          className="ml-auto flex shrink-0 items-center gap-1"
          data-testid="audio-quant-actions"
        >
          {state.downloading ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void state.cancelDownload()}
              aria-label={t('common:cancelDownload')}
              className="group relative w-24 justify-center overflow-hidden font-semibold"
            >
              <span
                className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
              <span className="relative z-10 tabular-nums group-hover:hidden">
                {percent}%
              </span>
              <IconX
                size={14}
                className="relative z-10 hidden group-hover:block"
              />
            </Button>
          ) : state.installed ? (
            <Button
              variant="outline"
              size="sm"
              className="w-24 justify-center"
              aria-label={openLabel}
              title={openLabel}
              onClick={openInAudios}
            >
              {t('hub:open')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="w-24 justify-center"
              disabled={!canDownload}
              aria-label={t('audios:model.download', { name: model.name })}
              onClick={download}
            >
              {t('audios:model.downloadShort')}
            </Button>
          )}
          {state.installed && !state.downloading ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-7"
              aria-label={t('audios:model.remove', { name: model.name })}
              onClick={() => setConfirmRemove(true)}
            >
              <IconTrash size={15} className="text-muted-foreground" />
            </Button>
          ) : (
            <span className="size-7" aria-hidden />
          )}
        </span>
      </div>
      {unavailable && !state.installed && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('audios:model.unavailable')}
        </p>
      )}

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('audios:model.removeTitle', { name: model.name })}
            </DialogTitle>
            <DialogDescription>
              {t('audios:model.removeDescription', {
                size: formatBytes(state.quant.bytes),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemove(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              autoFocus
              data-testid="audio-model-remove-confirm"
              onClick={() => {
                setConfirmRemove(false)
                void state.remove()
              }}
            >
              {t('audios:model.removeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
