import { memo, useEffect, useMemo, useState } from 'react'
import {
  IconCheck,
  IconChevronDown,
  IconCircleCheckFilled,
  IconTrash,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { useSelectedArtifact } from '@/hooks/useVideoSetting'
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
import type {
  DiffusionModality,
  ImageWorkflowId,
} from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageArtifactDownloadButton } from './ImageArtifactDownloadButton'
import { ImageModelRuntimeAction } from './ImageModelRuntimeAction'

type ImageModelSelectorProps = {
  /** `dialog` hides Remove and keeps the list short; `page` is the full manager. */
  variant?: 'page' | 'dialog'
  /**
   * Which families the list offers and which page's selection it writes:
   * image checkpoints for the Images page, video ones for the Video page.
   */
  modality?: DiffusionModality
  /**
   * The workflow the list is picked for. Only families that can run it are
   * offered — the setup wizard passes nothing and offers everything.
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
  modality = 'image',
  workflow,
  className,
  onDownloadStarted,
}: ImageModelSelectorProps) {
  const { t } = useTranslation()
  const catalog = useImageGenerationStore((state) => state.catalog)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )

  const families = useMemo(
    () =>
      (catalog?.families ?? [])
        .filter(
          (family) =>
            family.modality === modality &&
            family.engines.includes('sdcpp') &&
            (workflow === undefined ||
              familySupportsWorkflow(family.id, workflow))
        ),
    [catalog, modality, workflow]
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
  }, [families, installedIds])

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
    const choices = families.filter(
      (family) => family.transformer.quants.length > 0
    )

    return (
      <div
        className={cn(
          'space-y-1 rounded-xl border bg-secondary/20 p-1',
          className
        )}
        data-testid="image-model-selector"
      >
        {choices.map((family) => (
          <SetupFamilyRow
            key={family.id}
            family={family}
            modality={modality}
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
              modality={modality}
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
              modality={modality}
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
  modality,
  onDownloadStarted,
}: {
  family: DiffusionCatalogFamily
  modality: DiffusionModality
  onDownloadStarted?: (artifactId: string) => void
}) {
  const { t } = useTranslation()
  const { profile } = useHardwareTier()
  const initialQuant =
    recommendedQuant(family, profile, { teOnCpu: IS_MACOS }) ??
    family.transformer.quants[0]
  const [quantId, setQuantId] = useState(initialQuant?.id ?? '')
  const quant =
    family.transformer.quants.find((item) => item.id === quantId) ??
    family.transformer.quants[0]!
  const id = artifactId(family.id, quant.id)
  const artifact = useImageArtifact(id)
  const { setSelectedArtifactId } = useSelectedArtifact(modality)

  const start = () => {
    setSelectedArtifactId(id)
    void artifact.download()
    onDownloadStarted?.(id)
  }

  return (
    <div
      className="flex min-h-24 items-start gap-3 rounded-lg px-3 py-3 transition-colors duration-150 ease-out hover:bg-background"
      data-testid={`artifact-${id}`}
    >
      <ModelLogo
        icon={DIFFUSION_FAMILY_ICON_KEYS[family.id]}
        name={family.name}
        author={family.developer}
        className="size-9 rounded-lg"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{family.name}</p>
        {family.description && (
          <p
            className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground"
            title={family.description}
          >
            {family.description}
          </p>
        )}
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-muted/60 px-2 font-mono text-[11px] font-semibold transition-colors hover:bg-muted"
                aria-label={t('images:model.pick', {
                  name: family.name,
                  quant: quant.label,
                })}
              >
                {quant.label}
                <IconChevronDown size={13} aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 p-1">
              {family.transformer.quants.map((option) => {
                const fit = fitForQuant(family, option, profile, {
                  teOnCpu: IS_MACOS,
                }).fit
                const totalBytes =
                  option.bytes +
                  (family.vae?.bytes ?? 0) +
                  (family.audio_vae?.bytes ?? 0) +
                  family.text_encoders.reduce(
                    (sum, encoder) => sum + encoder.bytes,
                    0
                  )
                return (
                  <DropdownMenuItem
                    key={option.id}
                    className="gap-2 py-2"
                    onSelect={() => setQuantId(option.id)}
                  >
                    <span className="w-16 font-mono text-[11px] font-semibold">
                      {option.label}
                    </span>
                    <FitBadge
                      fit={fit}
                      className="px-2 py-0.5 text-[10px]"
                    />
                    <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                      {t('images:model.sizeGb', {
                        size: gb(totalBytes),
                      })}
                    </span>
                    {option.id === quant.id && (
                      <IconCheck size={14} className="shrink-0" />
                    )}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <FitBadge
            fit={artifact.fit}
            className="px-2 py-0.5 text-[10px]"
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
          variant="primary"
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
      <div className="space-y-1">{children}</div>
    </section>
  )
}

type FamilyBlockProps = {
  family: DiffusionCatalogFamily
  quants: DiffusionCatalogQuant[]
  modality: DiffusionModality
}

function FamilyBlock({ family, quants, modality }: FamilyBlockProps) {
  const { t } = useTranslation()
  const { profile } = useHardwareTier()
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const { selectedArtifactId, setSelectedArtifactId } =
    useSelectedArtifact(modality)
  const generating = useImageGenerationStore((state) => state.generating)
  const installedIds = useMemo(
    () => new Set(installedArtifacts.map((item) => item.id)),
    [installedArtifacts]
  )
  const initialQuantId = useMemo(() => {
    const persisted = quants.find(
      (quant) =>
        artifactId(family.id, quant.id) === selectedArtifactId &&
        installedIds.has(artifactId(family.id, quant.id))
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
    const currentExists = quants.some((quant) => quant.id === quantId)
    const currentIsInstalled = installedIds.has(
      artifactId(family.id, quantId)
    )
    const familyHasInstalledQuant = quants.some((quant) =>
      installedIds.has(artifactId(family.id, quant.id))
    )
    if (
      !currentExists ||
      (familyHasInstalledQuant && !currentIsInstalled)
    ) {
      setQuantId(initialQuantId ?? quants[0]?.id ?? '')
    }
  }, [family.id, initialQuantId, installedIds, quantId, quants])

  const quant = quants.find((item) => item.id === quantId) ?? quants[0]
  const id = quant ? artifactId(family.id, quant.id) : ''
  const artifact = useImageArtifact(id)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const installedQuants = quants.filter((option) =>
    installedIds.has(artifactId(family.id, option.id))
  )
  const availableQuants = quants.filter(
    (option) => !installedIds.has(artifactId(family.id, option.id))
  )
  const hasDownloadedQuant = installedQuants.length > 0

  if (!quant) return null

  const selectQuant = (nextQuantId: string) => {
    setQuantId(nextQuantId)
    setSelectedArtifactId(artifactId(family.id, nextQuantId))
  }

  const downloadCurrentQuant = () => {
    setSelectedArtifactId(id)
    void artifact.download()
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
        artifact.loaded && 'bg-secondary/70 hover:bg-secondary/70'
      )}
      data-testid={`family-${family.id}`}
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
          <p className="truncate text-sm font-medium leading-4">
            {family.name}
          </p>
          {family.description && (
            <p
              className="truncate text-[11px] leading-3.5 text-muted-foreground"
              title={family.description}
              data-testid="image-model-subtitle"
            >
              {family.description}
            </p>
          )}
        </div>
      </div>

      <div
        className="mt-3 flex min-w-0 items-center gap-1.5 pl-9"
        data-testid={`artifact-${id}`}
        data-compact-row="true"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-2 font-mono text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-muted"
              aria-label={t('images:model.pick', {
                name: family.name,
                quant: quant.label,
              })}
              disabled={generating}
            >
              <span className="shrink-0">{quant.label}</span>
              <IconChevronDown
                size={13}
                className="shrink-0 text-muted-foreground"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={4}
            className="w-[320px] max-w-[calc(100vw-3rem)] p-1"
            data-testid={`quant-menu-${family.id}`}
          >
            {installedQuants.length > 0 && (
              <>
                <DropdownMenuLabel
                  className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                  data-testid="quant-group-downloaded"
                >
                  {t('images:model.downloaded')}
                </DropdownMenuLabel>
                {installedQuants.map((option) => (
                  <InstalledQuantRow
                    key={option.id}
                    family={family}
                    option={option}
                    current={option.id === quant.id}
                    onSelect={() => selectQuant(option.id)}
                  />
                ))}
              </>
            )}
            {installedQuants.length > 0 && availableQuants.length > 0 && (
              <DropdownMenuSeparator />
            )}
            {availableQuants.length > 0 && (
              <>
                <DropdownMenuLabel
                  className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                  data-testid="quant-group-available"
                >
                  {t('images:model.available')}
                </DropdownMenuLabel>
                <div className="space-y-0.5">
                  {availableQuants.map((option) => (
                    <AvailableQuantRow
                      key={option.id}
                      family={family}
                      option={option}
                      profile={profile}
                    />
                  ))}
                </div>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="min-w-0 flex-1" />

        {!hasDownloadedQuant && (
          <ImageArtifactDownloadButton
            artifact={artifact}
            variant="primary"
            className="h-7 w-24 shrink-0 justify-center px-2"
            onRequestDownload={downloadCurrentQuant}
          />
        )}
        {hasDownloadedQuant && artifact.complete && !artifact.downloading && (
          <ImageModelRuntimeAction
            artifactId={id}
            modelName={family.name}
            modality={modality}
            disabled={generating}
          />
        )}
        {hasDownloadedQuant && artifact.installed && !artifact.downloading && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 shrink-0"
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

function InstalledQuantRow({
  family,
  option,
  current,
  onSelect,
}: {
  family: DiffusionCatalogFamily
  option: DiffusionCatalogQuant
  current: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  const optionId = artifactId(family.id, option.id)
  const artifact = useImageArtifact(optionId)

  if (!artifact.complete || artifact.downloading) {
    return (
      <QuantDownloadRow artifact={artifact} option={option}>
        <QuantLabel label={option.label} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {t('images:model.incomplete')}
        </span>
      </QuantDownloadRow>
    )
  }

  return (
    <DropdownMenuItem
      className="min-h-10 min-w-0 gap-2 py-1.5"
      data-testid={`quant-${optionId}`}
      aria-current={current ? 'true' : undefined}
      onSelect={onSelect}
    >
      <QuantLabel label={option.label} />
      <IconCircleCheckFilled
        size={14}
        className="shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-label={t('images:model.downloaded')}
        title={t('images:model.downloaded')}
        data-testid={`quant-downloaded-${optionId}`}
      />
      <span className="min-w-0 flex-1" aria-hidden />
      <IconCheck
        size={14}
        className={cn('shrink-0', current ? 'opacity-100' : 'opacity-0')}
        aria-hidden
        data-testid={`quant-current-${optionId}`}
      />
    </DropdownMenuItem>
  )
}

function AvailableQuantRow({
  family,
  option,
  profile,
}: {
  family: DiffusionCatalogFamily
  option: DiffusionCatalogQuant
  profile: ReturnType<typeof useHardwareTier>['profile']
}) {
  const { t } = useTranslation()
  const optionId = artifactId(family.id, option.id)
  const artifact = useImageArtifact(optionId)
  const fit = fitForQuant(family, option, profile, { teOnCpu: IS_MACOS }).fit
  const totalBytes =
    option.bytes +
    (family.vae?.bytes ?? 0) +
    (family.audio_vae?.bytes ?? 0) +
    family.text_encoders.reduce((sum, encoder) => sum + encoder.bytes, 0)

  return (
    <QuantDownloadRow artifact={artifact} option={option}>
      <QuantLabel label={option.label} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <FitBadge fit={fit} className="shrink-0 px-2 py-0.5 text-[10px]" />
        <span className="min-w-0 truncate whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
          {t('images:model.sizeGb', { size: gb(totalBytes) })}
        </span>
      </div>
    </QuantDownloadRow>
  )
}

function QuantLabel({ label }: { label: string }) {
  return (
    <span className="w-[62px] shrink-0 truncate rounded-[5px] bg-secondary px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold text-muted-foreground">
      {label}
    </span>
  )
}

function QuantDownloadRow({
  artifact,
  option,
  children,
}: {
  artifact: ReturnType<typeof useImageArtifact>
  option: DiffusionCatalogQuant
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const percent = Math.round(artifact.progress * 100)
  const actionLabel = artifact.downloading
    ? t('common:cancelDownload')
    : artifact.installed
      ? t('images:model.finishDownload')
      : t('images:model.download')

  const runAction = () => {
    if (artifact.downloading) {
      void artifact.cancelDownload()
    } else {
      void artifact.download()
    }
  }

  return (
    <DropdownMenuItem
      className="min-h-10 min-w-0 gap-2 py-1.5"
      data-testid={`quant-${artifact.id}`}
      aria-label={`${actionLabel} ${option.label}`}
      onSelect={(event) => {
        event.preventDefault()
        runAction()
      }}
    >
      {children}
      <span
        className={cn(
          'relative inline-flex h-7 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full px-2 text-xs font-medium',
          artifact.downloading
            ? 'border bg-background text-foreground shadow-xs dark:bg-input/30 dark:border-input'
            : 'bg-primary text-primary-foreground'
        )}
        data-testid={`quant-action-${artifact.id}`}
      >
        {artifact.downloading && (
          <span
            className="absolute inset-y-0 left-0 bg-primary/20 transition-[width] duration-200"
            style={{ width: `${percent}%` }}
            aria-hidden
          />
        )}
        <span className="relative z-10 truncate tabular-nums">
          {artifact.downloading ? `${percent}%` : actionLabel}
        </span>
      </span>
    </DropdownMenuItem>
  )
}

export default ImageModelSelector
