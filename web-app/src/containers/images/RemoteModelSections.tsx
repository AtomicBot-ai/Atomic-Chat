import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconCheck, IconCloud, IconSearch } from '@tabler/icons-react'
import { Fzf } from 'fzf'

import { route } from '@/constants/routes'
import { ModelLogo } from '@/containers/ModelLogo'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { useImageSetting } from '@/hooks/useImageSetting'
import {
  useRemoteMediaGroups,
  type RemoteMediaGroup,
} from '@/hooks/useRemoteMedia'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isSelfHostedGroup } from '@/lib/cloud-providers'
import { modelFamilyLogoSrc } from '@/lib/model-logo'
import { cn, getProviderTitle } from '@/lib/utils'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import type { MediaKind, MediaModelDescriptor } from '@/services/media/types'
import { useMediaCatalog } from '@/stores/media-catalog-store'

/** Past this many provider models the sections get a search field. */
const SEARCH_FROM = 8

type RemoteModelSectionsProps = {
  kind: MediaKind
  /** The Images page's mode: only models that can run it are offered. */
  workflow?: ImageWorkflowId
  /** Called after a model is picked, so the popover can close. */
  onPicked?: () => void
}

type Row = {
  group: RemoteMediaGroup
  descriptor: MediaModelDescriptor
  key: string
}

/**
 * The connected providers' image or video models, one section per provider, under the models on
 * this device. A provider model has nothing to download or start: picking it makes it the page's
 * model, and the next Generate goes to the provider through the core.
 */
export function RemoteModelSections({
  kind,
  workflow,
  onPicked,
}: RemoteModelSectionsProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const available = useMediaCatalog((state) => state.available)
  const groups = useRemoteMediaGroups(kind)
  const imagePick = useImageSetting((state) => state.selectedRemote)
  const setImagePick = useImageSetting((state) => state.setSelectedRemote)
  const videoPick = useVideoSetting((state) => state.selectedRemote)
  const setVideoPick = useVideoSetting((state) => state.setSelectedRemote)
  const picked = kind === 'image' ? imagePick : videoPick
  const setPicked = kind === 'image' ? setImagePick : setVideoPick
  const [query, setQuery] = useState('')

  const rows = useMemo(
    () =>
      groups.flatMap((group) =>
        group.models
          .filter(
            ({ descriptor }) =>
              workflow === undefined ||
              descriptor.workflows.some((w) => w === workflow)
          )
          .map(
            ({ descriptor }): Row => ({
              group,
              descriptor,
              key: `${group.provider.provider} ${getProviderTitle(group.provider.provider)} ${descriptor.name} ${descriptor.id}`,
            })
          )
      ),
    [groups, workflow]
  )
  const fzf = useMemo(
    () => new Fzf(rows, { selector: (row) => row.key }),
    [rows]
  )
  const visible = useMemo(() => {
    const needle = query.trim()
    if (!needle) return rows
    const found = new Set(fzf.find(needle).map((entry) => entry.item))
    return rows.filter((row) => found.has(row))
  }, [fzf, query, rows])

  const sections = useMemo(() => {
    const out: Array<{ group: RemoteMediaGroup; rows: Row[] }> = []
    for (const row of visible) {
      const last = out[out.length - 1]
      if (last && last.group === row.group) last.rows.push(row)
      else out.push({ group: row.group, rows: [row] })
    }
    return out
  }, [visible])

  const openCloud = () => {
    onPicked?.()
    void navigate({ to: route.cloud.index })
  }

  // A core without remote media has nothing to offer here, not even the way to the Cloud page.
  if (!available) return null

  return (
    <div className="space-y-2" data-testid={`remote-${kind}-models`}>
      {rows.length >= SEARCH_FROM && (
        <label className="flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-sm">
          <IconSearch size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('images:remote.search')}
            aria-label={t('images:remote.search')}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}
      {sections.map(({ group, rows: groupRows }) => (
        <section
          key={group.provider.provider}
          className="space-y-1 border-t pt-2"
          data-testid={`remote-section-${group.provider.provider}`}
        >
          <h3 className="flex items-center gap-1.5 px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <ProvidersAvatar provider={group.provider} className="size-3.5" />
            <span className="truncate">
              {getProviderTitle(group.provider.provider)}
            </span>
            <span className="rounded border border-border/60 px-1 py-px text-[9px] font-medium normal-case tracking-normal">
              {isSelfHostedGroup(group.provider)
                ? t('images:remote.selfHosted')
                : t('images:remote.cloud')}
            </span>
          </h3>
          <div className="space-y-1">
            {groupRows.map(({ descriptor }) => {
              const selected =
                picked?.provider === group.provider.provider &&
                picked.model === descriptor.id
              return (
                <button
                  key={descriptor.id}
                  type="button"
                  aria-pressed={selected}
                  data-testid={`remote-model-${group.provider.provider}-${descriptor.id}`}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ease-out hover:bg-secondary/50',
                    selected && 'bg-secondary/70 hover:bg-secondary/70'
                  )}
                  onClick={() => {
                    setPicked({
                      provider: group.provider.provider,
                      model: descriptor.id,
                    })
                    onPicked?.()
                  }}
                >
                  <RemoteModelLogo
                    provider={group.provider}
                    descriptor={descriptor}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium leading-4">
                      {descriptor.name}
                    </span>
                    {descriptor.name !== descriptor.id && (
                      <span
                        className="block truncate text-[11px] leading-3.5 text-muted-foreground"
                        title={descriptor.id}
                      >
                        {descriptor.id}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <IconCheck size={16} className="shrink-0 text-foreground" />
                  )}
                </button>
              )
            })}
          </div>
        </section>
      ))}
      {rows.length > 0 && visible.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('images:remote.noMatch')}
        </p>
      )}
      <button
        type="button"
        onClick={openCloud}
        className="flex w-full items-center gap-2 rounded-lg border-t px-2.5 pb-1 pt-2.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        data-testid="remote-models-connect"
      >
        <IconCloud size={14} className="shrink-0" />
        {t('images:remote.connect')}
      </button>
    </div>
  )
}

/** The model's brand mark when the app knows it, else the provider's own logo. */
export function RemoteModelLogo({
  provider,
  descriptor,
  className = 'size-7 rounded-md',
}: {
  provider: ProviderObject
  descriptor: Pick<MediaModelDescriptor, 'id' | 'name'>
  className?: string
}) {
  const logoName = modelFamilyLogoSrc(descriptor.id)
    ? descriptor.id
    : modelFamilyLogoSrc(descriptor.name)
      ? descriptor.name
      : null
  if (logoName) {
    return (
      <ModelLogo
        name={logoName}
        author={getProviderTitle(provider.provider)}
        className={className}
      />
    )
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center border border-border bg-secondary dark:border-input dark:bg-input/30',
        className
      )}
    >
      <ProvidersAvatar provider={provider} className="size-[60%]" />
    </span>
  )
}
