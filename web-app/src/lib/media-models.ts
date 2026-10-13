/**
 * A provider's image and video models: what it offers (the core's catalog), what the user enabled
 * (`provider.media`), and whether it is set up enough to generate. Pure helpers; the catalog itself
 * lives in `stores/media-catalog-store.ts`.
 */

import { isKeylessRemoteProvider } from '@/utils/registerRemoteProvider'

import type {
  MediaCatalogView,
  MediaDialect,
  MediaKind,
  MediaModelDescriptor,
} from '@/services/media/types'

/** The enabled media models of one kind. */
export function mediaModelsOf(
  provider: ProviderObject,
  kind: MediaKind
): ProviderMediaModel[] {
  return (provider.media?.models ?? []).filter((model) => model.kind === kind)
}

/** The adapter a provider's media of `kind` go through: its own (a custom server), else the catalog's. */
export function mediaDialectOf(
  provider: ProviderObject,
  kind: MediaKind,
  catalog: MediaCatalogView | null
): MediaDialect | undefined {
  const own =
    kind === 'image' ? provider.media?.image_api : provider.media?.video_api
  if (own) return own
  return catalog?.providers[provider.provider]?.[kind]?.api
}

/** Whether a provider generates media at all (a catalog entry, or an adapter its registration names). */
export function offersMedia(
  provider: ProviderObject,
  catalog: MediaCatalogView | null
): boolean {
  return (
    mediaDialectOf(provider, 'image', catalog) !== undefined ||
    mediaDialectOf(provider, 'video', catalog) !== undefined
  )
}

/**
 * Set up for media: models enabled, and the provider reachable the way it takes requests (a key,
 * or a keyless server of the user's own).
 */
export function isMediaConnected(provider: ProviderObject): boolean {
  if ((provider.media?.models.length ?? 0) === 0) return false
  if (provider.api_key?.trim()) return true
  return isKeylessRemoteProvider(provider) || provider.media_only === true
}

/** `kind:id`: how `ProviderMedia.offered` names a model. */
export const offerKey = (kind: MediaKind, id: string): string => `${kind}:${id}`

/** Every curated catalog model of a provider, as enabled entries: each kind's default first. */
export function catalogModels(
  providerId: string,
  catalog: MediaCatalogView | null
): ProviderMediaModel[] {
  const section = catalog?.providers[providerId]
  const out: ProviderMediaModel[] = []
  for (const kind of ['image', 'video'] as const) {
    const models = section?.[kind]?.models ?? []
    const ordered = [
      ...models.filter((m) => m.default),
      ...models.filter((m) => !m.default),
    ]
    for (const model of ordered)
      out.push({ id: model.id, kind, name: model.name })
  }
  return out
}

/**
 * The provider's media with the catalog's models it has not been given yet: all of them the first
 * time, later only the ones conf adds — the way a registry provider lists its chat models. A model
 * the user removed is never put back: it stays in `offered`. A list from before `offered` existed
 * counts what it holds as offered. `undefined` when nothing changes, and while `ready` is false (a
 * keyless server that has not answered yet would otherwise show as connected).
 */
export function mediaToSeed(
  provider: ProviderObject,
  catalog: MediaCatalogView | null,
  ready: boolean
): ProviderMedia | undefined {
  if (!ready || !catalog) return undefined
  const candidates = catalogModels(provider.provider, catalog)
  if (candidates.length === 0) return undefined
  const media = provider.media
  const held = (media?.models ?? []).map((m) => offerKey(m.kind, m.id))
  const offered = new Set(media?.offered ?? held)
  const fresh = candidates.filter((m) => !offered.has(offerKey(m.kind, m.id)))
  if (fresh.length === 0 && media?.offered) return undefined
  const present = new Set(held)
  return {
    ...(media ?? {}),
    models: [
      ...(media?.models ?? []),
      ...fresh.filter((m) => !present.has(offerKey(m.kind, m.id))),
    ],
    offered: [
      ...new Set([
        ...offered,
        ...candidates.map((m) => offerKey(m.kind, m.id)),
      ]),
    ],
  }
}

/** `media` with every model a server listed that it does not hold yet (by id and kind). */
export function withListedModels(
  media: ProviderMedia | undefined,
  listed: readonly ProviderMediaModel[]
): ProviderMedia {
  const held = new Set((media?.models ?? []).map((m) => offerKey(m.kind, m.id)))
  return {
    ...(media ?? {}),
    models: [
      ...(media?.models ?? []),
      ...listed.filter((m) => !held.has(offerKey(m.kind, m.id))),
    ],
  }
}

/** `models` with `model` added (or replaced, by id and kind). */
export function withMediaModel(
  media: ProviderMedia | undefined,
  model: ProviderMediaModel
): ProviderMedia {
  const models = (media?.models ?? []).filter(
    (m) => !(m.id === model.id && m.kind === model.kind)
  )
  return { ...(media ?? {}), models: [...models, model] }
}

/** `models` without the model of that id and kind. */
export function withoutMediaModel(
  media: ProviderMedia | undefined,
  id: string,
  kind: MediaKind
): ProviderMedia {
  return {
    ...(media ?? {}),
    models: (media?.models ?? []).filter(
      (m) => !(m.id === id && m.kind === kind)
    ),
  }
}

/**
 * What the app knows about an enabled model: the catalog's (or the listing's) descriptor, else a
 * bare one with the adapter's defaults so the form still shows something sane.
 */
export function describeMediaModel(
  provider: ProviderObject,
  model: ProviderMediaModel,
  catalog: MediaCatalogView | null,
  listed: readonly MediaModelDescriptor[] = []
): MediaModelDescriptor | undefined {
  const found =
    listed.find((m) => m.id === model.id && m.kind === model.kind) ??
    catalog?.providers[provider.provider]?.[model.kind]?.models.find(
      (m) => m.id === model.id
    )
  if (found) return found
  const api = mediaDialectOf(provider, model.kind, catalog)
  if (!api) return undefined
  const defaults = catalog?.dialects[api]
  const base = {
    id: model.id,
    name: model.name ?? model.id,
    api,
    source: 'live' as const,
  }
  return model.kind === 'image'
    ? {
        ...base,
        kind: 'image',
        workflows: (defaults?.workflows ?? ['create']) as Extract<
          MediaModelDescriptor,
          { kind: 'image' }
        >['workflows'],
        params: (defaults?.params ?? {}) as Extract<
          MediaModelDescriptor,
          { kind: 'image' }
        >['params'],
      }
    : {
        ...base,
        kind: 'video',
        workflows: (defaults?.workflows ?? ['create']) as Extract<
          MediaModelDescriptor,
          { kind: 'video' }
        >['workflows'],
        params: (defaults?.params ?? {}) as Extract<
          MediaModelDescriptor,
          { kind: 'video' }
        >['params'],
      }
}
