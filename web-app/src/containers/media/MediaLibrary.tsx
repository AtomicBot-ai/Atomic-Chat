/**
 * Everything this app has generated.
 *
 * Task 8 built the index and the asset records; Task 11 wired materialisation
 * so files actually reach it. This is the first thing that renders any of it.
 *
 * Not virtualised, deliberately. `@tanstack/react-virtual` IS already a
 * dependency, so the plan permits it - but virtualising costs a measured
 * container and fixed row heights, and buys nothing until a user has thousands
 * of generations. The grid caps what it draws instead and says so, which is
 * honest, far simpler, and adds no dependency. Swap in the virtualiser when a
 * real library gets big enough to need it.
 */

import { useEffect, useMemo, useState } from 'react'

import { convertFileSrc } from '@tauri-apps/api/core'

import { Card } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { AssetDetail, type MediaReRunRequest } from './AssetDetail'
import type { MediaAsset } from '@/services/media/assets'
import { useMediaLibraryStore } from '@/stores/media-library-store'

/** How many tiles are drawn before the grid asks the user to filter. */
export const MEDIA_LIBRARY_PAGE_SIZE = 200

const ALL = '__all__'

type MediaLibraryProps = {
  onReRun?: (request: MediaReRunRequest) => void
  onContinue?: (asset: MediaAsset) => Promise<void> | void
}

/** The thumbnail if one was made, else the asset itself. */
function thumbSourceOf(asset: MediaAsset): string {
  return convertFileSrc(asset.thumb_path ?? asset.path)
}

function Tile({
  asset,
  selected,
  onSelect,
}: {
  asset: MediaAsset
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  // An index entry outlives its file: the user can delete, move or sync it away
  // at any time. A broken <img> would render as a torn icon with no
  // explanation, so the failure is caught and named instead.
  const [missing, setMissing] = useState(false)

  return (
    <button
      type="button"
      data-testid="media-library-tile"
      onClick={onSelect}
      className={
        selected
          ? 'flex flex-col gap-1 rounded-xl border border-primary p-2 text-left'
          : 'flex flex-col gap-1 rounded-xl border border-border/60 p-2 text-left'
      }
    >
      {missing ? (
        <span
          data-testid="media-library-missing"
          className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground"
        >
          {t('media:library.fileMissing', { defaultValue: 'File missing' })}
        </span>
      ) : asset.media_type === 'video' && !asset.thumb_path ? (
        // No thumbnail was captured, so show the clip's own first frame rather
        // than an <img> pointed at an .mp4, which can only ever render broken.
        <video
          data-testid="media-library-thumb"
          className="h-24 w-full rounded-lg object-cover"
          src={convertFileSrc(asset.path)}
          preload="metadata"
          muted
          onError={() => setMissing(true)}
        />
      ) : (
        <img
          data-testid="media-library-thumb"
          className="h-24 w-full rounded-lg object-cover"
          src={thumbSourceOf(asset)}
          alt={asset.provenance.model_label}
          onError={() => setMissing(true)}
        />
      )}
      <span className="truncate text-xs font-medium">
        {asset.name ?? asset.provenance.model_label}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {asset.provenance.task}
      </span>
    </button>
  )
}

export function MediaLibrary({ onReRun, onContinue }: MediaLibraryProps) {
  const { t } = useTranslation()
  const assets = useMediaLibraryStore((state) => state.assets)
  const loaded = useMediaLibraryStore((state) => state.loaded)
  const load = useMediaLibraryStore((state) => state.load)
  const remove = useMediaLibraryStore((state) => state.remove)

  const [task, setTask] = useState(ALL)
  const [provider, setProvider] = useState(ALL)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) void load()
  }, [load, loaded])

  const tasks = useMemo(
    () => [...new Set(assets.map((asset) => asset.provenance.task))].sort(),
    [assets]
  )
  const providers = useMemo(
    () =>
      [...new Set(assets.map((asset) => asset.provenance.provider_id))].sort(),
    [assets]
  )

  const filtered = useMemo(
    () =>
      assets
        .filter((asset) => task === ALL || asset.provenance.task === task)
        .filter(
          (asset) => provider === ALL || asset.provenance.provider_id === provider
        )
        // Newest first: the thing a user just made is the thing they want.
        .sort((a, b) => b.created_at - a.created_at),
    [assets, provider, task]
  )

  const shown = filtered.slice(0, MEDIA_LIBRARY_PAGE_SIZE)
  const selected =
    filtered.find((asset) => asset.asset_id === selectedId) ?? null

  return (
    <Card title={t('media:library.title', { defaultValue: 'Library' })}>
      <div className="flex flex-wrap items-end gap-3 pb-3">
        <div className="space-y-1">
          <label htmlFor="media-library-task" className="text-xs">
            {t('media:library.task', { defaultValue: 'Task' })}
          </label>
          <select
            id="media-library-task"
            className="border-input h-9 rounded-md border bg-transparent px-2"
            value={task}
            onChange={(event) => setTask(event.target.value)}
          >
            <option value={ALL}>
              {t('media:library.allTasks', { defaultValue: 'All tasks' })}
            </option>
            {tasks.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="media-library-provider" className="text-xs">
            {t('media:library.provider', { defaultValue: 'Provider' })}
          </label>
          <select
            id="media-library-provider"
            className="border-input h-9 rounded-md border bg-transparent px-2"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value={ALL}>
              {t('media:library.allProviders', {
                defaultValue: 'All providers',
              })}
            </option>
            {providers.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground">
          {assets.length === 0
            ? t('media:library.empty', {
                defaultValue:
                  'Nothing here yet. Generate something in Media and it will appear here.',
              })
            : t('media:library.noMatches', {
                defaultValue: 'No generations match these filters.',
              })}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {shown.map((asset) => (
            <Tile
              key={asset.asset_id}
              asset={asset}
              selected={asset.asset_id === selectedId}
              onSelect={() => setSelectedId(asset.asset_id)}
            />
          ))}
        </div>
      )}

      {filtered.length > shown.length && (
        <p className="pt-2 text-xs text-muted-foreground">
          {t('media:library.truncated', {
            shown: MEDIA_LIBRARY_PAGE_SIZE,
            total: filtered.length,
            defaultValue:
              'Showing the {{shown}} most recent of {{total}}. Narrow the filters to see older ones.',
          })}
        </p>
      )}

      {selected && (
        <div className="pt-4">
          <AssetDetail
            asset={selected}
            onReRun={onReRun}
            onContinue={onContinue}
            onDelete={(assetId) => {
              setSelectedId(null)
              void remove(assetId)
            }}
          />
        </div>
      )}
    </Card>
  )
}
