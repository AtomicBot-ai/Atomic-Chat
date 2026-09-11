import { memo, useMemo, useState } from 'react'
import {
  IconLoader2,
  IconPlayerPlay,
  IconPlayerStop,
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
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { artifactId } from '@/lib/diffusion/models'
import { formatBytes } from '@/lib/downloadFormat'
import { cn } from '@/lib/utils'
import type {
  DiffusionCatalogFamily,
  DiffusionCatalogQuant,
} from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageArtifactDownloadButton } from './ImageArtifactDownloadButton'

type ImageModelSelectorProps = {
  /** `dialog` hides Remove and keeps the list short; `page` is the full manager. */
  variant?: 'page' | 'dialog'
  className?: string
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
  className,
}: ImageModelSelectorProps) {
  const { t } = useTranslation()
  const catalog = useImageGenerationStore((state) => state.catalog)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const [planFor, setPlanFor] = useState<string | null>(null)

  const families = useMemo(
    () =>
      (catalog?.families ?? []).filter(
        (family) =>
          family.modality === 'image' && family.engines.includes('sdcpp')
      ),
    [catalog]
  )

  const installedIds = useMemo(
    () => new Set(installedArtifacts.map((artifact) => artifact.id)),
    [installedArtifacts]
  )

  const sections = useMemo(() => {
    const installed: Array<[DiffusionCatalogFamily, DiffusionCatalogQuant[]]> = []
    const available: Array<[DiffusionCatalogFamily, DiffusionCatalogQuant[]]> = []
    for (const family of families) {
      const have = family.transformer.quants.filter((quant) =>
        installedIds.has(artifactId(family.id, quant.id))
      )
      const rest = family.transformer.quants.filter(
        (quant) => !installedIds.has(artifactId(family.id, quant.id))
      )
      if (have.length > 0) installed.push([family, have])
      if (rest.length > 0) available.push([family, rest])
    }
    return { installed, available }
  }, [families, installedIds])

  if (!catalog) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="image-models-loading">
        {t('images:model.loadingCatalog')}
      </p>
    )
  }

  return (
    <div className={cn('space-y-4', className)} data-testid="image-model-selector">
      {sections.installed.length > 0 && (
        <Section title={t('images:model.installed')}>
          {sections.installed.map(([family, quants]) => (
            <FamilyBlock
              key={family.id}
              family={family}
              quants={quants}
              variant={variant}
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

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
  onRequestDownload: (artifactId: string) => void
}

function FamilyBlock({
  family,
  quants,
  variant,
  onRequestDownload,
}: FamilyBlockProps) {
  return (
    <div className="rounded-xl border bg-secondary/40 p-3" data-testid={`family-${family.id}`}>
      <div className="flex items-center gap-3">
        <ModelLogo
          name={family.name}
          author={family.developer}
          className="size-10 rounded-lg"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{family.name}</p>
          {family.description && (
            <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
              {family.description}
            </p>
          )}
        </div>
      </div>
      <ul className="mt-2 space-y-1">
        {quants.map((quant) => (
          <ArtifactRow
            key={quant.id}
            family={family}
            quant={quant}
            variant={variant}
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
  variant: 'page' | 'dialog'
  onRequestDownload: (artifactId: string) => void
}

function ArtifactRow({
  family,
  quant,
  variant,
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
        'flex items-center gap-3 rounded-lg border bg-background px-3 py-2',
        selected && 'border-primary'
      )}
      data-testid={`artifact-${id}`}
      data-selected={selected ? 'true' : undefined}
    >
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={pick}
        aria-pressed={selected}
        aria-label={t('images:model.pick', {
          name: family.name,
          quant: quant.label,
        })}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{quant.label}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('images:model.sizeGb', { size: gb(artifact.totalBytes) })}
          </span>
          {quant.recommended && (
            <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
              {t('images:model.recommended')}
            </span>
          )}
          <FitBadge fit={artifact.fit} className="px-2 py-0.5" />
          {artifact.installed && !artifact.complete && !artifact.downloading && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {t('images:model.incomplete')}
            </span>
          )}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1.5">
        <ImageArtifactDownloadButton
          artifact={artifact}
          onRequestDownload={() => onRequestDownload(id)}
        />
        {artifact.complete && !artifact.loaded && (
          <Button
            size="sm"
            variant="outline"
            disabled={artifact.loading || generating}
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
            disabled={generating}
            onClick={() => void unloadModel()}
            aria-label={t('images:model.unload')}
          >
            <IconPlayerStop size={14} />
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
