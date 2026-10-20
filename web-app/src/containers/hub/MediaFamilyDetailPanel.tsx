import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  IconChevronDown,
  IconChevronUp,
  IconExternalLink,
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
import { ModelLogo } from '@/containers/ModelLogo'
import { FitBadge } from '@/containers/hub/FitBadge'
import { ImageArtifactDownloadButton } from '@/containers/images/ImageArtifactDownloadButton'
import { route } from '@/constants/routes'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useSelectedArtifact } from '@/hooks/useVideoSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { pickDefaultQuant, recommendedQuant } from '@/lib/diffusion/fit'
import { artifactId } from '@/lib/diffusion/models'
import { workflowsForFamily } from '@/lib/diffusion/workflows'
import { formatBytes } from '@/lib/downloadFormat'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type {
  DiffusionCatalogFamily,
  DiffusionCatalogQuant,
} from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'

const gb = (bytes: number) => formatBytes(bytes, 1024 ** 3)

export type MediaFamilyDetailPanelProps = {
  family: DiffusionCatalogFamily | null
  className?: string
}

/**
 * The right-hand panel for an image or video family, shaped like the Chat
 * category's: one quant with its fit, size and download — or, once it is on
 * disk, the way into the studio that runs it — behind a disclosure listing
 * every quant, then the details and the repo's README. The same
 * `useImageArtifact` state as the Images and Video model lists, so progress
 * and removals agree with those pages.
 */
export function MediaFamilyDetailPanel({
  family,
  className,
}: MediaFamilyDetailPanelProps) {
  const { t } = useTranslation()
  const { profile } = useHardwareTier()

  if (!family) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center p-6 text-sm text-muted-foreground',
          className
        )}
      >
        {t('hub:selectModel')}
      </div>
    )
  }

  const repo = family.transformer.repo
  const workflows =
    family.modality === 'image' ? workflowsForFamily(family.id) : []

  return (
    <div className={cn('flex flex-col gap-4 p-6', className)}>
      <header className="flex items-start gap-3">
        <ModelLogo
          icon={DIFFUSION_FAMILY_ICON_KEYS[family.id]}
          name={family.name}
          author={family.developer}
        />
        <div className="min-w-0 flex-1">
          <h1
            className="min-w-0 truncate text-xl font-semibold"
            title={family.name}
          >
            {family.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">{repo}</p>
        </div>
        <a
          href={`https://huggingface.co/${repo}`}
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

      {family.description && (
        <p className="text-sm text-muted-foreground">{family.description}</p>
      )}

      {/* Keyed by family: a quant picked for one family means nothing for
          the next. */}
      <MediaDownloadOptions key={family.id} family={family} profile={profile} />

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:details')}</h2>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <DetailCell label={t('hub:defaultSize')}>
            {family.defaults.width}×{family.defaults.height}
          </DetailCell>
          <DetailCell label={t('hub:steps')}>
            {family.defaults.steps}
          </DetailCell>
          <DetailCell label={t('hub:license')}>
            {family.license ?? '—'}
          </DetailCell>
          {family.video ? (
            <DetailCell label={t('hub:frameRate')}>
              {family.video.fps} fps
            </DetailCell>
          ) : (
            <div className="rounded-md bg-muted/40 p-3">
              <dt className="text-muted-foreground">{t('hub:capabilities')}</dt>
              <dd className="mt-1.5 flex flex-wrap gap-1.5">
                {workflows.map((workflow) => (
                  <span
                    key={workflow}
                    className="rounded-[5px] bg-secondary px-1.5 py-px text-[10px] font-semibold text-muted-foreground"
                  >
                    {t(`images:workflow.${workflow}.label`)}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  )
}

/**
 * The Chat category's collapsed quant selector for a diffusion family: the
 * quant the family opens on (an installed one, else the recommended, else the
 * smallest) with its actions, and a disclosure listing every quant.
 */
function MediaDownloadOptions({
  family,
  profile,
}: {
  family: DiffusionCatalogFamily
  profile: ReturnType<typeof useHardwareTier>['profile']
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )

  const recommendedId = recommendedQuant(family, profile, {
    teOnCpu: IS_MACOS,
  })?.id
  const defaultQuant = useMemo(
    () =>
      pickDefaultQuant(
        family,
        profile,
        (installedArtifacts ?? [])
          .filter((artifact) => artifact.family === family.id)
          .map((artifact) => artifact.id),
        { teOnCpu: IS_MACOS }
      ),
    [family, profile, installedArtifacts]
  )
  const selected =
    family.transformer.quants.find((quant) => quant.id === selectedId) ??
    defaultQuant

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
      <MediaQuantRow
        family={family}
        quant={selected}
        recommended={selected.id === recommendedId}
        expanded={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
      />
      {expanded && (
        <ul className="mt-3 border-t border-border pt-2">
          {family.transformer.quants.map((quant) => (
            <MediaQuantOption
              key={quant.id}
              family={family}
              quant={quant}
              recommended={quant.id === recommendedId}
              current={quant.id === selected.id}
              onSelect={() => {
                setSelectedId(quant.id)
                setExpanded(false)
              }}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/** The facts every quant is told by: fit, label, size, and the recommendation. */
function QuantFacts({
  quant,
  fit,
  totalBytes,
  recommended,
}: {
  quant: DiffusionCatalogQuant
  fit: ReturnType<typeof useImageArtifact>['fit']
  totalBytes: number
  recommended: boolean
}) {
  const { t } = useTranslation()
  return (
    <>
      <FitBadge fit={fit} className="shrink-0 px-1.5 py-0.5 text-[10px]" />
      <span className="shrink-0 rounded-[5px] bg-secondary px-[7px] py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
        {quant.label}
      </span>
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {t('images:model.sizeGb', { size: gb(totalBytes) })}
      </span>
      {recommended && (
        <span className="min-w-0 truncate rounded-[5px] border border-border px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
          {t('images:model.recommended')}
        </span>
      )}
    </>
  )
}

/** One quant in the disclosure: picking it makes it the one the row acts on. */
function MediaQuantOption({
  family,
  quant,
  recommended,
  current,
  onSelect,
}: {
  family: DiffusionCatalogFamily
  quant: DiffusionCatalogQuant
  recommended: boolean
  current: boolean
  onSelect: () => void
}) {
  const artifact = useImageArtifact(artifactId(family.id, quant.id))
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={current ? 'true' : undefined}
        data-testid={`media-quant-option-${artifactId(family.id, quant.id)}`}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/40',
          current && 'bg-muted/60'
        )}
      >
        <QuantFacts
          quant={quant}
          fit={artifact.fit}
          totalBytes={artifact.totalBytes}
          recommended={recommended}
        />
      </button>
    </li>
  )
}

function DetailCell({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
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
 * The selected quant: its facts as the disclosure's toggle, then Download,
 * its progress or Open, and the remove button once it has files on disk.
 */
function MediaQuantRow({
  family,
  quant,
  recommended,
  expanded,
  onToggle,
}: {
  family: DiffusionCatalogFamily
  quant: DiffusionCatalogQuant
  recommended: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const id = artifactId(family.id, quant.id)
  const artifact = useImageArtifact(id)
  const { setSelectedArtifactId } = useSelectedArtifact(family.modality)
  const generating = useImageGenerationStore((state) => state.generating)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  const ready = artifact.complete && !artifact.downloading
  const openLabel =
    family.modality === 'video' ? t('hub:openInVideo') : t('hub:openInImages')

  // Picking the checkpoint here is what makes the studio open on it, the
  // same selection a download from the studio's own list records.
  const download = () => {
    setSelectedArtifactId(id)
    void artifact.download()
  }

  const openInStudio = () => {
    setSelectedArtifactId(id)
    void navigate({
      to: family.modality === 'video' ? route.videos.index : route.images.index,
    })
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

  const Chevron = expanded ? IconChevronUp : IconChevronDown

  return (
    <div
      // At 1024 px the panel is too narrow for the facts and the actions on
      // one line; the actions then wrap under the facts.
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
      data-testid={`media-quant-${id}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={t('hub:downloadOptions')}
        className="flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-md bg-muted/40 px-2 py-2 text-left hover:bg-muted/60"
      >
        <QuantFacts
          quant={quant}
          fit={artifact.fit}
          totalBytes={artifact.totalBytes}
          recommended={recommended}
        />
        <Chevron size={15} className="ml-auto shrink-0 text-muted-foreground" />
      </button>
      {/* One action column in every state: Download, its progress and Open
          share the w-24 slot, and the remove slot is held even when empty. */}
      <span
        className="ml-auto flex shrink-0 items-center gap-1"
        data-testid="media-quant-actions"
      >
        {ready ? (
          <Button
            variant="outline"
            size="sm"
            className="w-24 justify-center"
            aria-label={openLabel}
            title={openLabel}
            onClick={openInStudio}
          >
            {t('hub:open')}
          </Button>
        ) : (
          <ImageArtifactDownloadButton
            artifact={artifact}
            variant="primary"
            className="w-24 justify-center"
            onRequestDownload={download}
          />
        )}
        {/* A half-downloaded quant is removable too: its files take disk
            space whether or not the download is ever finished. */}
        {artifact.installed && !artifact.downloading ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-7"
            disabled={generating}
            aria-label={t('images:model.remove')}
            onClick={() => setConfirmRemove(true)}
          >
            <IconTrash size={15} className="text-muted-foreground" />
          </Button>
        ) : (
          <span className="size-7" aria-hidden />
        )}
      </span>

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
