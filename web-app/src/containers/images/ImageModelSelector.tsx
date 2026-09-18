import { memo, useEffect, useMemo, useState } from 'react'
import {
  IconCheck,
  IconChevronDown,
  IconCircleCheckFilled,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconTrash,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FitBadge } from '@/containers/hub/FitBadge'
import { ModelLogo } from '@/containers/ModelLogo'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { fitForQuant, recommendedQuant } from '@/lib/diffusion/fit'
import { artifactId } from '@/lib/diffusion/models'
import { familySupportsWorkflow } from '@/lib/diffusion/workflows'
import { formatBytes } from '@/lib/downloadFormat'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type {
  DiffusionCatalogFamily,
  DiffusionCatalogQuant,
} from '@/services/diffusion-catalog-registry'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageArtifactDownloadButton } from './ImageArtifactDownloadButton'

type ImageModelSelectorProps = {
  /** `dialog` hides Remove and keeps the list short; `page` is the full manager. */
  variant?: 'page' | 'dialog'
  /**
   * The workflow the list is picked for. Families that cannot run it are
   * listed last, marked, and cannot be run or fetched from here — the setup
   * wizard passes nothing and offers everything.
   */
  workflow?: ImageWorkflowId
  className?: string
  /** Setup closes as soon as a background download has been accepted. */
  onDownloadStarted?: (artifactId: string) => void
}

const gb = (bytes: number) => formatBytes(bytes, 1024 ** 3)

/**
 * Installed / Available image models. Each family stays one compact card;
 * its quantizations live in a dropdown instead of expanding the list into a
 * file manager. Downloading starts immediately and includes every side file
 * required by the selected checkpoint.
 */
export const ImageModelSelector = memo(function ImageModelSelector({
  variant = 'page',
  workflow,
  className,
  onDownloadStarted,
}: ImageModelSelectorProps) {
  const { t } = useTranslation()
  const catalog = useImageGenerationStore((state) => state.catalog)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const { profile } = useHardwareTier()

  const fits = (family: DiffusionCatalogFamily) =>
    workflow === undefined || familySupportsWorkflow(family.id, workflow)

  // Families that can run the workflow first; the rest stay visible so the
  // user sees what would need switching, but sink to the bottom.
  const families = useMemo(
    () =>
      (catalog?.families ?? [])
        .filter(
          (family) =>
            family.modality === 'image' && family.engines.includes('sdcpp')
        )
        .sort((a, b) => Number(fits(b)) - Number(fits(a))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, workflow]
  )

  const installedIds = useMemo(
    () => new Set(installedArtifacts.map((artifact) => artifact.id)),
    [installedArtifacts]
  )

  const sections = useMemo(() => {
    const installed: Array<[DiffusionCatalogFamily, DiffusionCatalogQuant[]]> =
      []
    const available: Array<[DiffusionCatalogFamily, DiffusionCatalogQuant[]]> =
      []
    for (const family of families) {
      const have = family.transformer.quants.find((quant) =>
        installedIds.has(artifactId(family.id, quant.id))
      )
      if (family.transformer.quants.length === 0) continue
      if (have) installed.push([family, family.transformer.quants])
      else available.push([family, family.transformer.quants])
    }
    return { installed, available }
  }, [families, installedIds, profile])

  if (!catalog) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="image-models-loading"
      >
        {t('images:model.loadingCatalog')}
      </p>
    )
  }

  if (variant === 'dialog') {
    const choices = families
      .map((family) => ({
        family,
        quant:
          recommendedQuant(family, profile, { teOnCpu: IS_MACOS }) ??
          family.transformer.quants[0],
      }))
      .filter(
        (
          choice
        ): choice is {
          family: DiffusionCatalogFamily
          quant: DiffusionCatalogQuant
        } => Boolean(choice.quant)
      )

    return (
      <div
        className={cn(
          'space-y-1 rounded-xl border bg-secondary/20 p-1',
          className
        )}
        data-testid="image-model-selector"
      >
        {choices.map(({ family, quant }) => (
          <SetupFamilyRow
            key={family.id}
            family={family}
            quant={quant}
            onDownloadStarted={onDownloadStarted}
          />
        ))}
        {choices.length === 0 && (
          <p className="p-3 text-sm text-muted-foreground">
            {t('images:model.noneInCatalog')}
          </p>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn('space-y-2', className)}
      data-testid="image-model-selector"
    >
      {sections.installed.length > 0 && (
        <Section title={t('images:model.installed')}>
          {sections.installed.map(([family, quants]) => (
            <FamilyBlock
              key={family.id}
              family={family}
              quants={quants}
              unsupportedFor={fits(family) ? null : (workflow ?? null)}
            />
          ))}
        </Section>
      )}
      {sections.available.length > 0 && (
        <Section title={t('images:model.available')}>
          {sections.available.map(([family, quants]) => (
            <FamilyBlock
              key={family.id}
              family={family}
              quants={quants}
              unsupportedFor={fits(family) ? null : (workflow ?? null)}
            />
          ))}
        </Section>
      )}
      {families.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t('images:model.noneInCatalog')}
        </p>
      )}
    </div>
  )
})

function SetupFamilyRow({
  family,
  quant,
  onDownloadStarted,
}: {
  family: DiffusionCatalogFamily
  quant: DiffusionCatalogQuant
  onDownloadStarted?: (artifactId: string) => void
}) {
  const { t } = useTranslation()
  const id = artifactId(family.id, quant.id)
  const artifact = useImageArtifact(id)
  const setSelectedArtifactId = useImageSetting(
    (state) => state.setSelectedArtifactId
  )

  const start = () => {
    setSelectedArtifactId(id)
    void artifact.download()
    onDownloadStarted?.(id)
  }

  return (
    <div
      className="flex min-h-16 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-background"
      data-testid={`artifact-${id}`}
    >
      <ModelLogo
        icon={DIFFUSION_FAMILY_ICON_KEYS[family.id]}
        name={family.name}
        author={family.developer}
        className="size-8 rounded-lg"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{family.name}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <FitBadge
            fit={artifact.fit}
            className="rounded-none border-0 bg-transparent p-0 font-medium dark:bg-transparent"
          />
          <span aria-hidden>·</span>
          <span>
            {t('images:model.sizeGb', { size: gb(artifact.totalBytes) })}
          </span>
        </div>
      </div>
      {artifact.complete ? (
        <span className="flex w-24 items-center justify-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <IconCircleCheckFilled size={16} />
          {t('images:model.downloaded')}
        </span>
      ) : (
        <ImageArtifactDownloadButton
          artifact={artifact}
          onRequestDownload={start}
        />
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  // A rule between the sections is the only line in the list: families and
  // rows are told apart by indent and hover, not by nested boxes.
  return (
    <section className="space-y-1 [&:not(:first-child)]:border-t [&:not(:first-child)]:pt-2">
      <h3 className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

type FamilyBlockProps = {
  family: DiffusionCatalogFamily
  quants: DiffusionCatalogQuant[]
  /** The workflow this family cannot run, when the list is picked for one. */
  unsupportedFor: ImageWorkflowId | null
}

function FamilyBlock({ family, quants, unsupportedFor }: FamilyBlockProps) {
  const { t } = useTranslation()
  const { profile } = useHardwareTier()
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const selectedArtifactId = useImageSetting(
    (state) => state.selectedArtifactId
  )
  const setSelectedArtifactId = useImageSetting(
    (state) => state.setSelectedArtifactId
  )
  const unloadModel = useImageGenerationStore((state) => state.unloadModel)
  const generating = useImageGenerationStore((state) => state.generating)
  const installedIds = useMemo(
    () => new Set(installedArtifacts.map((item) => item.id)),
    [installedArtifacts]
  )
  const initialQuantId = useMemo(() => {
    const persisted = quants.find(
      (quant) => artifactId(family.id, quant.id) === selectedArtifactId
    )
    const installed = quants.find((quant) =>
      installedIds.has(artifactId(family.id, quant.id))
    )
    return (
      persisted ??
      installed ??
      recommendedQuant(family, profile, { teOnCpu: IS_MACOS }) ??
      quants[0]
    )?.id
  }, [family, installedIds, profile, quants, selectedArtifactId])
  const [quantId, setQuantId] = useState(initialQuantId ?? quants[0]?.id ?? '')

  useEffect(() => {
    if (!quants.some((quant) => quant.id === quantId)) {
      setQuantId(initialQuantId ?? quants[0]?.id ?? '')
    }
  }, [initialQuantId, quantId, quants])

  const quant = quants.find((item) => item.id === quantId) ?? quants[0]
  const id = quant ? artifactId(family.id, quant.id) : ''
  const artifact = useImageArtifact(id)
  const disabled = unsupportedFor !== null
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  if (!quant) return null

  const selectQuant = (nextQuantId: string) => {
    setQuantId(nextQuantId)
  }

  const download = () => {
    setSelectedArtifactId(id)
    void artifact.download()
  }

  const start = async () => {
    if (!artifact.complete || artifact.loading || artifact.loaded) return
    setSelectedArtifactId(id)
    const toastId = toast.loading(t('images:model.startingToast'))
    await artifact.load()
    const loadedId =
      useImageGenerationStore.getState().status?.model.loaded?.modelId
    if (loadedId === id) {
      toast.success(t('images:model.startedToast', { name: family.name }), {
        id: toastId,
      })
    } else {
      toast.error(t('images:model.startFailed', { name: family.name }), {
        id: toastId,
      })
    }
  }

  const stop = async () => {
    const toastId = toast.loading(t('images:model.stoppingToast'))
    await unloadModel()
    const stillLoaded =
      useImageGenerationStore.getState().status?.model.state === 'loaded'
    if (stillLoaded) {
      toast.error(t('images:model.stopFailed', { name: family.name }), {
        id: toastId,
      })
    } else {
      toast.success(t('images:model.stoppedToast', { name: family.name }), {
        id: toastId,
      })
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await artifact.remove()
      setConfirmRemove(false)
    } catch (error) {
      toast.error(t('images:model.removeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div
      className={cn(
        'rounded-lg px-2.5 py-2 transition-colors duration-150 ease-out hover:bg-secondary/50',
        artifact.loaded && 'bg-secondary/70 hover:bg-secondary/70',
        disabled && 'opacity-60'
      )}
      data-testid={`family-${family.id}`}
      data-unsupported={unsupportedFor ?? undefined}
      data-artifact-id={id}
    >
      <div className="flex items-start gap-2.5">
        <ModelLogo
          icon={DIFFUSION_FAMILY_ICON_KEYS[family.id]}
          name={family.name}
          author={family.developer}
          className="mt-0.5 size-7 rounded-md"
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium leading-tight">
            <span className="truncate">{family.name}</span>
            {unsupportedFor && (
              <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                {t('images:model.notForWorkflow', {
                  workflow: t(`images:workflow.${unsupportedFor}.label`),
                })}
              </span>
            )}
          </p>
          {family.description && (
            <p
              className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground"
              title={family.description}
            >
              {family.description}
            </p>
          )}
        </div>
      </div>

      <div
        className="mt-2 flex items-center gap-1.5 pl-9"
        data-testid={`artifact-${id}`}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-muted/45 px-2 text-left transition-colors hover:bg-muted/70"
              aria-label={t('images:model.pick', {
                name: family.name,
                quant: quant.label,
              })}
              disabled={generating || disabled}
            >
              <span className="shrink-0 rounded-[5px] bg-secondary px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
                {quant.label}
              </span>
              <FitBadge
                fit={artifact.fit}
                className="shrink-0 rounded-none border-0 bg-transparent p-0 text-[10px] font-medium dark:bg-transparent"
              />
              <span className="min-w-0 truncate text-[11px] tabular-nums text-muted-foreground">
                {artifact.downloading
                  ? t('images:model.progress', {
                      current: formatBytes(
                        artifact.currentBytes,
                        artifact.downloadTotalBytes
                      ),
                      total: formatBytes(
                        artifact.downloadTotalBytes,
                        artifact.downloadTotalBytes
                      ),
                    })
                  : t('images:model.sizeGb', {
                      size: gb(artifact.totalBytes),
                    })}
              </span>
              <IconChevronDown
                size={14}
                className="ml-auto shrink-0 text-muted-foreground"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={4}
            className="w-[260px] max-w-[calc(100vw-3rem)] p-1"
          >
            {quants.map((option) => {
              const optionId = artifactId(family.id, option.id)
              const fit = fitForQuant(family, option, profile, {
                teOnCpu: IS_MACOS,
              }).fit
              const totalBytes =
                option.bytes +
                (family.vae?.bytes ?? 0) +
                family.text_encoders.reduce(
                  (sum, encoder) => sum + encoder.bytes,
                  0
                )
              return (
                <DropdownMenuItem
                  key={option.id}
                  className="gap-2 py-2"
                  data-testid={`quant-${optionId}`}
                  onSelect={() => selectQuant(option.id)}
                >
                  <span className="w-[62px] shrink-0 rounded-[5px] bg-secondary px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold text-muted-foreground">
                    {option.label}
                  </span>
                  <FitBadge
                    fit={fit}
                    className="shrink-0 rounded-none border-0 bg-transparent p-0 text-[10px] font-medium dark:bg-transparent"
                  />
                  <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                    {t('images:model.sizeGb', { size: gb(totalBytes) })}
                  </span>
                  <IconCheck
                    size={14}
                    className={cn(
                      'shrink-0',
                      option.id === quant.id ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {!disabled && (!artifact.complete || artifact.downloading) && (
          <ImageArtifactDownloadButton
            artifact={artifact}
            onRequestDownload={download}
          />
        )}
        {artifact.complete && !artifact.downloading && !artifact.loaded && (
          <Button
            size="sm"
            variant="outline"
            className="w-20 justify-center"
            disabled={artifact.loading || generating || disabled}
            onClick={() => void start()}
            aria-label={t('images:model.load')}
          >
            {artifact.loading ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconPlayerPlay size={14} />
            )}
            {artifact.loading
              ? t('images:model.loading')
              : t('images:model.load')}
          </Button>
        )}
        {artifact.loaded && (
          <Button
            size="sm"
            variant="outline"
            className="w-20 justify-center"
            disabled={generating}
            onClick={() => void stop()}
            aria-label={t('images:model.unload')}
          >
            <IconPlayerStopFilled size={14} />
            {t('images:model.unload')}
          </Button>
        )}
        {artifact.installed && !artifact.downloading && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={generating}
            aria-label={t('images:model.remove')}
            onClick={() => setConfirmRemove(true)}
          >
            <IconTrash size={15} className="text-muted-foreground" />
          </Button>
        )}
      </div>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('images:model.removeTitle', {
                name: family.name,
                quant: quant.label,
              })}
            </DialogTitle>
            <DialogDescription>
              {t('images:model.removeDescription')}
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
              disabled={removing}
              onClick={() => void remove()}
            >
              {t('images:model.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ImageModelSelector
