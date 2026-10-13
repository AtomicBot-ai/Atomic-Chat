import { useEffect, useMemo, useState } from 'react'
import { IconLoader, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Card, CardItem } from '@/containers/Card'
import { AdvancedSelect } from '@/containers/images/AdvancedSelect'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isProviderConnected } from '@/lib/cloud-providers'
import {
  isMediaConnected,
  mediaDialectOf,
  mediaModelsOf,
  withMediaModel,
  withoutMediaModel,
} from '@/lib/media-models'
import { cn } from '@/lib/utils'
import type { MediaDialect, MediaKind, MediaModelDescriptor } from '@/services/media/types'
import { CUSTOM_IMAGE_APIS, CUSTOM_VIDEO_APIS } from '@/services/media/types'
import { listingKey, useMediaCatalog } from '@/stores/media-catalog-store'

type CloudMediaModelsCardProps = {
  provider: ProviderObject
  /** A server the user added: its media adapters are chosen here, not by the catalog. */
  custom: boolean
  onChange: (media: ProviderMedia) => void
}

const KINDS: readonly MediaKind[] = ['image', 'video']

/** A workflow's short label key, for the badges beside a model. */
const WORKFLOW_KEYS: Record<string, string> = {
  'create': 'cloud:media.workflow.create',
  'edit': 'cloud:media.workflow.edit',
  'reference': 'cloud:media.workflow.reference',
  'transform': 'cloud:media.workflow.transform',
  'inpaint': 'cloud:media.workflow.inpaint',
  'image-to-video': 'cloud:media.workflow.imageToVideo',
}

/**
 * The provider's image and video models: its own list, apart from the chat models above. What the
 * provider offers comes from the core (the catalog, and the provider's live listing on Reload);
 * what is here is what the Images and Video pages offer. Removing one is per provider, never the
 * chat list's global tombstone.
 */
export function CloudMediaModelsCard({ provider, custom, onChange }: CloudMediaModelsCardProps) {
  const { t } = useTranslation()
  const catalog = useMediaCatalog((s) => s.catalog)
  const listings = useMediaCatalog((s) => s.listings)
  const listModels = useMediaCatalog((s) => s.listModels)
  const offered = useMemo(
    () => KINDS.filter((kind) => mediaDialectOf(provider, kind, catalog) !== undefined),
    [provider, catalog]
  )
  const [kind, setKind] = useState<MediaKind>(offered[0] ?? 'image')
  useEffect(() => {
    if (offered.length > 0 && !offered.includes(kind)) setKind(offered[0] as MediaKind)
  }, [offered, kind])

  const listing = listings[listingKey(provider.provider, kind)]
  const enabled = mediaModelsOf(provider, kind)
  // The provider answers a listing only once the core has it registered: a key, or a server of the
  // user's own that answered its chat models (or makes media only).
  const reachable =
    isProviderConnected(provider) || isMediaConnected(provider) || provider.media_only === true
  const catalogModels = useMemo(
    () =>
      (catalog?.providers[provider.provider]?.[kind]?.models ?? []) as MediaModelDescriptor[],
    [catalog, provider.provider, kind]
  )
  const available = useMemo(() => {
    const byId = new Map<string, MediaModelDescriptor>()
    for (const model of [...catalogModels, ...(listing?.models ?? [])]) byId.set(model.id, model)
    return [...byId.values()].filter((model) => !enabled.some((m) => m.id === model.id))
  }, [catalogModels, listing, enabled])

  const describe = (id: string) =>
    listing?.models.find((m) => m.id === id) ?? catalogModels.find((m) => m.id === id)

  const setApi = (which: MediaKind, api: MediaDialect | 'none') => {
    const key = which === 'image' ? 'image_api' : 'video_api'
    const next: ProviderMedia = { ...(provider.media ?? { models: [] }) }
    if (api === 'none') {
      delete next[key]
      next.models = next.models.filter((m) => m.kind !== which)
    } else next[key] = api
    onChange(next)
  }

  const apiOptions = (which: MediaKind): Array<[MediaDialect | 'none', string]> => [
    ['none', t('cloud:media.api.none')],
    ...(which === 'image' ? CUSTOM_IMAGE_APIS : CUSTOM_VIDEO_APIS).map(
      (api): [MediaDialect, string] => [api, t(`cloud:media.api.${api}`)]
    ),
  ]

  if (!custom && offered.length === 0) return null

  return (
    <Card
      header={
        <div className="mb-4 flex flex-col gap-3" data-testid="cloud-media-card">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-studio text-base font-medium text-foreground">
                {t('cloud:media.title')}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('cloud:media.description')}</p>
            </div>
            {offered.length > 0 && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!reachable || listing?.status === 'loading'}
                  title={reachable ? undefined : t('cloud:media.connectFirst')}
                  onClick={() => void listModels(provider.provider, kind)}
                >
                  {listing?.status === 'loading' ? (
                    <IconLoader size={16} className="animate-spin text-muted-foreground" />
                  ) : (
                    <IconRefresh size={16} className="text-muted-foreground" />
                  )}
                  <span>{t('cloud:models.reload')}</span>
                </Button>
                <AddMediaModel
                  available={available}
                  onAdd={(model) =>
                    onChange(withMediaModel(provider.media, { id: model.id, kind, name: model.name }))
                  }
                  onManual={(id) => onChange(withMediaModel(provider.media, { id, kind }))}
                />
              </div>
            )}
          </div>
          {custom && (
            <div className="flex flex-col gap-2 rounded-md border border-border/60 p-3">
              <AdvancedSelect
                label={t('cloud:media.api.imageLabel')}
                value={provider.media?.image_api ?? 'none'}
                options={apiOptions('image')}
                onChange={(api) => setApi('image', api)}
              />
              <AdvancedSelect
                label={t('cloud:media.api.videoLabel')}
                value={provider.media?.video_api ?? 'none'}
                options={apiOptions('video')}
                onChange={(api) => setApi('video', api)}
              />
            </div>
          )}
          {offered.length > 1 && (
            <div className="flex gap-1" role="tablist">
              {offered.map((option) => (
                <Button
                  key={option}
                  role="tab"
                  aria-selected={kind === option}
                  size="sm"
                  variant={kind === option ? 'secondary' : 'ghost'}
                  onClick={() => setKind(option)}
                >
                  {t(option === 'image' ? 'cloud:media.images' : 'cloud:media.videos', {
                    count: mediaModelsOf(provider, option).length,
                  })}
                </Button>
              ))}
            </div>
          )}
        </div>
      }
    >
      {offered.length === 0 ? (
        <p className="py-2 text-muted-foreground">{t('cloud:media.pickApi')}</p>
      ) : enabled.length === 0 ? (
        listing?.error ? (
          <p className="py-2 text-destructive" role="alert">
            {listing.error}
          </p>
        ) : (
          <p className="py-2 text-muted-foreground">
            {t(kind === 'image' ? 'cloud:media.emptyImages' : 'cloud:media.emptyVideos')}
          </p>
        )
      ) : (
        enabled.map((model) => {
          const descriptor = describe(model.id)
          return (
            <CardItem
              key={`${model.kind}:${model.id}`}
              title={
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <h3 className="line-clamp-1 font-medium" title={model.id}>
                      {descriptor?.name ?? model.name ?? model.id}
                    </h3>
                    {(descriptor?.workflows ?? []).map((workflow) => (
                      <span
                        key={workflow}
                        className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {t(WORKFLOW_KEYS[workflow] ?? workflow)}
                      </span>
                    ))}
                  </div>
                  {(descriptor?.name ?? model.name) && (
                    <span className="truncate text-xs text-muted-foreground">{model.id}</span>
                  )}
                </div>
              }
              actions={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('cloud:media.remove', { name: descriptor?.name ?? model.id })}
                  onClick={() => onChange(withoutMediaModel(provider.media, model.id, model.kind))}
                >
                  <IconTrash size={16} className="text-muted-foreground" />
                </Button>
              }
            />
          )
        })
      )}
      {listing?.error && enabled.length > 0 && (
        <p className="pt-2 text-xs text-destructive" role="alert">
          {listing.error}
        </p>
      )}
    </Card>
  )
}

function AddMediaModel({
  available,
  onAdd,
  onManual,
}: {
  available: MediaModelDescriptor[]
  onAdd: (model: MediaModelDescriptor) => void
  onManual: (id: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? available.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(needle))
    : available
  const exact = needle !== '' && available.every((m) => m.id.toLowerCase() !== needle)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="icon-sm" aria-label={t('cloud:media.add')}>
          <IconPlus size={16} className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('cloud:media.searchPlaceholder')}
        />
        <div className="mt-2 max-h-72 overflow-y-auto">
          {visible.map((model) => (
            <button
              key={model.id}
              type="button"
              className={cn(
                'flex w-full flex-col items-start rounded px-2 py-1.5 text-left hover:bg-secondary'
              )}
              onClick={() => {
                onAdd(model)
                setOpen(false)
                setQuery('')
              }}
            >
              <span className="text-sm text-foreground">{model.name}</span>
              <span className="text-xs text-muted-foreground">{model.id}</span>
            </button>
          ))}
          {visible.length === 0 && !exact && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('cloud:media.noneToAdd')}</p>
          )}
          {exact && (
            <button
              type="button"
              className="flex w-full rounded px-2 py-1.5 text-left text-sm hover:bg-secondary"
              onClick={() => {
                onManual(query.trim())
                setOpen(false)
                setQuery('')
              }}
            >
              {t('cloud:media.addById', { id: query.trim() })}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
