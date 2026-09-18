import { memo, useMemo, useState } from 'react'
import {
  IconCircleCheckFilled,
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconTrash,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import ImageDownloadPlanDialog from '@/containers/dialogs/ImageDownloadPlanDialog'
import { FitBadge } from '@/containers/hub/FitBadge'
import { ModelLogo } from '@/containers/ModelLogo'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { recommendedQuant } from '@/lib/diffusion/fit'
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
 * Installed / Available checkpoints, one row per quant, with a fit badge for
 * this machine and Download / Load / Unload / Remove.
 *
 * Picking a quant that is not on disk opens the download plan first — a
 * family's side files can be several GB, and shared between families, so the
 * user sees what will actually be fetched before anything moves.
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
  const [planFor, setPlanFor] = useState<string | null>(null)
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
    const installed: Array<[DiffusionCatalogFamily, DiffusionCatalogQuant[]]> = []
    const available: Array<[DiffusionCatalogFamily, DiffusionCatalogQuant[]]> = []
    for (const family of families) {
      // One family, one row. Prefer what is already on disk; otherwise show
      // the quant selected for this machine. Alternate quants remain an
      // implementation detail instead of turning the picker into a file list.
      const have = family.transformer.quants.find((quant) =>
        installedIds.has(artifactId(family.id, quant.id))
      )
      const recommended = recommendedQuant(family, profile, {
        teOnCpu: IS_MACOS,
      })
      const choice = have ?? recommended ?? family.transformer.quants[0]
      if (!choice) continue
      if (have) installed.push([family, [choice]])
      else available.push([family, [choice]])
    }
    return { installed, available }
  }, [families, installedIds, profile])

  if (!catalog) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="image-models-loading">
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
        className={cn('space-y-1 rounded-xl border bg-secondary/20 p-1', className)}
        data-testid="image-model-selector"
      >
        {choices.map(({ family, quant }, index) => (
          <SetupFamilyRow
            key={family.id}
            family={family}
            quant={quant}
            recommended={index === 0}
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
    <div className={cn('space-y-2', className)} data-testid="image-model-selector">
      {sections.installed.length > 0 && (
        <Section title={t('images:model.installed')}>
          {sections.installed.map(([family, quants]) => (
            <FamilyBlock
              key={family.id}
              family={family}
              quants={quants}
              variant={variant}
              unsupportedFor={fits(family) ? null : workflow ?? null}
              onRequestDownload={setPlanFor}
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
              variant={variant}
              unsupportedFor={fits(family) ? null : workflow ?? null}
              onRequestDownload={setPlanFor}
            />
          ))}
        </Section>
      )}
      {families.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t('images:model.noneInCatalog')}
        </p>
      )}
      <ImageDownloadPlanDialog
        artifactId={planFor}
        onOpenChange={(open) => {
          if (!open) setPlanFor(null)
        }}
      />
    </div>
  )
})

function SetupFamilyRow({
  family,
  quant,
  recommended,
  onDownloadStarted,
}: {
  family: DiffusionCatalogFamily
  quant: DiffusionCatalogQuant
  recommended: boolean
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
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{family.name}</span>
          {recommended && (
            <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              {t('images:model.recommended')}
            </span>
          )}
        </p>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <FitBadge
            fit={artifact.fit}
            className="rounded-none border-0 bg-transparent p-0 font-medium dark:bg-transparent"
          />
          <span aria-hidden>·</span>
          <span>{t('images:model.sizeGb', { size: gb(artifact.totalBytes) })}</span>
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
  variant: 'page' | 'dialog'
  /** The workflow this family cannot run, when the list is picked for one. */
  unsupportedFor: ImageWorkflowId | null
  onRequestDownload: (artifactId: string) => void
}

function FamilyBlock({
  family,
  quants,
  variant,
  unsupportedFor,
  onRequestDownload,
}: FamilyBlockProps) {
  const { t } = useTranslation()
  const { profile } = useHardwareTier()
  // Over every quant of the family, not just this section's: the badge must
  // sit on the same row whether that row is listed as installed or available.
  const recommendedId = useMemo(
    () => recommendedQuant(family, profile, { teOnCpu: IS_MACOS })?.id ?? null,
    [family, profile]
  )

  return (
    <div
      data-testid={`family-${family.id}`}
      data-unsupported={unsupportedFor ?? undefined}
      className={cn(unsupportedFor && 'opacity-60')}
    >
      <div className="flex items-center gap-2.5 px-2 py-1">
        <ModelLogo
          icon={DIFFUSION_FAMILY_ICON_KEYS[family.id]}
          name={family.name}
          author={family.developer}
          className="size-7 rounded-md"
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
            <p className="truncate text-[11px] leading-snug text-muted-foreground" title={family.description}>
              {family.description}
            </p>
          )}
        </div>
      </div>
      {/* Indented to the family name, so the quants read as its children. */}
      <ul className="space-y-0.5 pl-[38px]">
        {quants.map((quant) => (
          <ArtifactRow
            key={quant.id}
            family={family}
            quant={quant}
            recommended={quant.id === recommendedId}
            variant={variant}
            disabled={unsupportedFor !== null}
            onRequestDownload={onRequestDownload}
          />
        ))}
      </ul>
    </div>
  )
}

type ArtifactRowProps = {
  family: DiffusionCatalogFamily
  quant: DiffusionCatalogQuant
  /** The quant this machine should run, per {@link recommendedQuant}. */
  recommended: boolean
  variant: 'page' | 'dialog'
  /** The family cannot run the current workflow: no pick, run or fetch from here. */
  disabled?: boolean
  onRequestDownload: (artifactId: string) => void
}

function ArtifactRow({
  family,
  quant,
  recommended,
  variant,
  disabled = false,
  onRequestDownload,
}: ArtifactRowProps) {
  const { t } = useTranslation()
  const id = artifactId(family.id, quant.id)
  const artifact = useImageArtifact(id)
  const selectedArtifactId = useImageSetting((state) => state.selectedArtifactId)
  const setSelectedArtifactId = useImageSetting(
    (state) => state.setSelectedArtifactId
  )
  const unloadModel = useImageGenerationStore((state) => state.unloadModel)
  const generating = useImageGenerationStore((state) => state.generating)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const selected = selectedArtifactId === id

  const pick = () => {
    setSelectedArtifactId(id)
    if (!artifact.complete && !artifact.downloading) onRequestDownload(id)
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
    <li
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-secondary/50',
        selected && 'bg-secondary hover:bg-secondary'
      )}
      data-testid={`artifact-${id}`}
      data-selected={selected ? 'true' : undefined}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
        onClick={pick}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={t('images:model.pick', {
          name: family.name,
          quant: quant.label,
        })}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{quant.label}</span>
          {recommended && (
            <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
              {t('images:model.recommended')}
            </span>
          )}
          {artifact.installed && !artifact.complete && !artifact.downloading && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {t('images:model.incomplete')}
            </span>
          )}
        </span>
        {/* Its own line in every state, so the size turning into a byte count
            mid-download changes text, not the row's height. The fit badge
            sits here too, so the first line stays short beside the buttons. */}
        <span
          className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          aria-live={artifact.downloading ? 'polite' : undefined}
        >
          {/* The fit as coloured words, not a third pill beside the badge
              and the button. */}
          <FitBadge
            fit={artifact.fit}
            className="rounded-none border-0 bg-transparent p-0 font-medium dark:bg-transparent"
          />
          <span aria-hidden>·</span>
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
            : t('images:model.sizeGb', { size: gb(artifact.totalBytes) })}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1.5">
        {!(disabled && !artifact.downloading) && (
          <ImageArtifactDownloadButton
            artifact={artifact}
            onRequestDownload={() => onRequestDownload(id)}
          />
        )}
        {artifact.complete && !artifact.loaded && (
          <Button
            size="sm"
            variant="outline"
            className="w-24 justify-center"
            disabled={artifact.loading || generating || disabled}
            onClick={() => void artifact.load()}
            aria-label={t('images:model.load')}
          >
            {artifact.loading ? (
              <IconLoader2 size={14} className="animate-spin" />
            ) : (
              <IconPlayerPlay size={14} />
            )}
            {artifact.loading ? t('images:model.loading') : t('images:model.load')}
          </Button>
        )}
        {artifact.loaded && (
          <Button
            size="sm"
            variant="outline"
            className="w-24 justify-center"
            disabled={generating}
            onClick={() => void unloadModel()}
            aria-label={t('images:model.unload')}
          >
            <IconPlayerStopFilled size={14} />
            {t('images:model.unload')}
          </Button>
        )}
        {variant === 'page' && artifact.installed && !artifact.downloading && (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={generating}
            aria-label={t('images:model.remove')}
            onClick={() => setConfirmRemove(true)}
          >
            <IconTrash size={16} className="text-muted-foreground" />
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
            <DialogDescription>{t('images:model.removeDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
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
    </li>
  )
}

export default ImageModelSelector
