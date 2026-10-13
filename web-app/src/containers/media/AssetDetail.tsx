/**
 * One generated asset, and everything the app truthfully knows about it.
 *
 * The honesty rules here are the point of the component, not decoration:
 *
 *  - A seed that was never recorded renders as "not recorded", never as 0. A
 *    fabricated zero would make "run this again identically" quietly produce a
 *    different image, which is the exact failure decision D8 closed.
 *  - "Re-run" is only OFFERED when it can be honoured. For an asset generated
 *    before D8 landed, the seed is genuinely unrecoverable, so the button is
 *    absent rather than present-and-lying.
 *  - "Re-run with a new seed" DROPS the seed instead of picking one. The job
 *    manager resolves a blank seed (D8), so dropping it keeps exactly one place
 *    in the app responsible for choosing seeds.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Forward, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MediaAsset } from '@/services/media/assets'
import { saveMediaAssetAs } from '@/services/media/saveAs'
import { useMediaLibraryStore } from '@/stores/media-library-store'

/** What the studio needs to run a generation again. */
export type MediaReRunRequest = {
  provider_id: string
  model_id: string
  task: string
  params: Record<string, unknown>
}

type AssetDetailProps = {
  asset: MediaAsset
  onReRun?: (request: MediaReRunRequest) => void
  onContinue?: (asset: MediaAsset) => Promise<void> | void
  onDelete?: (assetId: string) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AssetDetail({
  asset,
  onReRun,
  onContinue,
  onDelete,
}: AssetDetailProps) {
  const { t } = useTranslation()
  const { provenance } = asset
  const rename = useMediaLibraryStore((state) => state.rename)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(asset.name ?? '')
  const [continuing, setContinuing] = useState(false)

  const handleSaveAs = async () => {
    try {
      const saved = await saveMediaAssetAs(asset)
      if (saved) {
        toast.success(
          t('media:asset.saved', { defaultValue: 'Saved to {{path}}', path: saved })
        )
      }
    } catch (error) {
      toast.error(
        t('media:asset.saveFailed', {
          defaultValue: 'Could not save the file: {{message}}',
          message: error instanceof Error ? error.message : String(error),
        })
      )
    }
  }

  const handleReveal = () => {
    void getServiceHub()
      .opener()
      .revealItemInDir(asset.path)
      .catch(() =>
        toast.error(
          t('media:asset.revealFailed', {
            defaultValue: 'The file could not be found. It may have been moved or deleted.',
          })
        )
      )
  }

  const commitRename = () => {
    void rename(asset.asset_id, draft)
    setRenaming(false)
  }

  // Only what the app can stand behind. `resolved_seed` is set solely when the
  // seed was actually known - see materialize().
  const seedKnown = typeof provenance.resolved_seed === 'number'

  const baseRequest: MediaReRunRequest = {
    provider_id: provenance.provider_id,
    model_id: provenance.model_id,
    task: provenance.task,
    params: { ...provenance.params },
  }

  const handleReRun = () => onReRun?.(baseRequest)

  const handleReRunNewSeed = () => {
    const params = { ...provenance.params }
    // Dropped, not replaced. The manager resolves it, so the seed is chosen in
    // one place for every path into generation.
    delete params.seed
    onReRun?.({ ...baseRequest, params })
  }

  const handleContinue = async () => {
    if (!onContinue) return
    setContinuing(true)
    try {
      await onContinue(asset)
    } finally {
      setContinuing(false)
    }
  }

  return (
    <div
      data-testid="media-asset-detail"
      className="flex flex-col gap-3 rounded-md border border-border/60 p-4"
    >
      <div className="space-y-1">
        {renaming ? (
          <input
            autoFocus
            aria-label={t('media:asset.rename', { defaultValue: 'Rename' })}
            className="border-input h-8 w-full rounded-md border bg-transparent px-2 text-sm"
            value={draft}
            placeholder={provenance.model_label}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <h2 className="font-medium text-foreground">
            {asset.name ?? provenance.model_label}
          </h2>
        )}
        <p className="text-xs text-muted-foreground">
          {provenance.task} · {provenance.provider_id} ·{' '}
          {formatBytes(asset.bytes)}
        </p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          {t('media:asset.prompt', { defaultValue: 'Prompt' })}
        </dt>
        <dd className="break-words">{String(provenance.params.prompt ?? '')}</dd>

        <dt className="text-muted-foreground">
          {t('media:asset.seed', { defaultValue: 'Seed' })}
        </dt>
        <dd>
          {seedKnown ? (
            String(provenance.resolved_seed)
          ) : (
            <span className="text-muted-foreground">
              {t('media:asset.seedUnknown', {
                defaultValue: 'not recorded (generated before the app tracked it)',
              })}
            </span>
          )}
        </dd>

        <dt className="text-muted-foreground">
          {t('media:asset.created', { defaultValue: 'Created' })}
        </dt>
        <dd>{new Date(asset.created_at).toLocaleString()}</dd>

        <dt className="text-muted-foreground">
          {t('media:asset.file', { defaultValue: 'File' })}
        </dt>
        <dd className="break-all">{asset.path}</dd>
      </dl>

      <div className="flex flex-wrap gap-2">
        {onContinue && asset.media_type === 'video' && (
          <Button
            size="sm"
            onClick={() => void handleContinue()}
            disabled={continuing}
          >
            {continuing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Forward className="mr-1 h-3.5 w-3.5" />
            )}
            {t('media:asset.continue', {
              defaultValue: 'Continue this video',
            })}
          </Button>
        )}
        <Button size="sm" onClick={() => void handleSaveAs()}>
          {t('media:asset.saveAs', { defaultValue: 'Save as…' })}
        </Button>
        <Button size="sm" variant="secondary" onClick={handleReveal}>
          {t('media:asset.showInFolder', { defaultValue: 'Show in folder' })}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setDraft(asset.name ?? '')
            setRenaming(true)
          }}
        >
          {t('media:asset.rename', { defaultValue: 'Rename' })}
        </Button>
        {seedKnown && onReRun && (
          <Button size="sm" onClick={handleReRun}>
            {t('media:asset.reRun', { defaultValue: 'Re-run' })}
          </Button>
        )}
        {onReRun && (
          <Button size="sm" variant="link" onClick={handleReRunNewSeed}>
            {t('media:asset.reRunNewSeed', {
              defaultValue: 'Re-run with a new seed',
            })}
          </Button>
        )}
        {onDelete && (
          <Button
            size="sm"
            variant="link"
            onClick={() => onDelete(asset.asset_id)}
          >
            {t('media:asset.delete', { defaultValue: 'Delete' })}
          </Button>
        )}
      </div>
    </div>
  )
}
