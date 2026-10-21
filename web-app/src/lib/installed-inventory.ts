/**
 * What the app has put on this computer, for the Downloads page: every local
 * model file, image and video checkpoint, embedding and decision model, the
 * voice model and the engine builds, plus the downloads still running.
 *
 * Each source keeps its own list (the provider registry, the image-generation
 * store, the embedding and decision stores, the core's engine answer), so the
 * page is a merge of them, built here without React so the rules can be tested
 * directly. Sizes are what is on disk where a source knows it, and `null`
 * where it does not: the core reports no size for an installed engine build.
 *
 * What no source lists is read off the disk (`downloads-disk`): the size of an
 * MLX model whose `model.yml` records none, the drafts MLX caches, and the
 * partial files of downloads that never finished.
 */

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import {
  VOICE_MODEL_BYTES,
  VOICE_MODEL_ID,
  VOICE_MODEL_NAME,
  VOICE_PROVIDER,
} from '@/constants/voice'
import type { DownloadProgressProps } from '@/hooks/useDownloadStore'
import {
  isDiffusionModelDownloadTaskId,
  planArtifactDownload,
  resolveDiffusionDownloadTaskId,
  type InstalledArtifact,
} from '@/lib/diffusion/models'
import {
  decisionDownloadTaskId,
  isDecisionDownloadTaskId,
} from '@/lib/decision/models'
import {
  embeddingDownloadTaskId,
  isEmbeddingDownloadTaskId,
} from '@/lib/embedding/models'
import { isFoundryLocalDownloadId } from '@/lib/foundry-local/download-id'
import {
  FOUNDRY_LOCAL_PROVIDER,
  LLAMACPP_PROVIDERS,
  MLX_PROVIDER,
  managedProviderIds,
} from '@/lib/hub-installed'
import {
  LLAMACPP_MODELS_ROOT,
  type DownloadRoot,
  type MlxDraft,
  type PartialDownload,
} from '@/lib/downloads-disk'
import { isManagedDownloadId } from '@/lib/managed-engine/download-id'
import { getProviderTitle } from '@/lib/utils'
import {
  decisionCheckpointBytes,
  decisionQuantLabel,
  type DecisionCatalogModel,
} from '@/services/decision-catalog-registry'
import { isDiffusionEngineTaskId } from '@/services/diffusion/engine'
import type { DiffusionModelFile } from '@/services/diffusion/types'
import {
  findFamily,
  findQuant,
  type DiffusionCatalog,
} from '@/services/diffusion-catalog-registry'
import {
  embeddingDiskBytes,
  embeddingQuantLabel,
  type EmbeddingCatalogModel,
} from '@/services/embedding-catalog-registry'
import { isEngineBuildTaskId } from '@/services/engine-builds/install'
import type {
  EngineId,
  EngineNotRemovableReason,
  EngineVersions,
} from '@/services/engines/types'
import { ENGINE_IDS } from '@/services/engines/types'
import { isEngineUpdateTaskId } from '@/services/engines/update'

/** The page's category filter; "All" is the absence of one. */
export type InventoryCategory = 'local' | 'image' | 'video' | 'voice' | 'engine'

export const INVENTORY_CATEGORIES: readonly InventoryCategory[] = [
  'local',
  'image',
  'video',
  'voice',
  'engine',
]

/** What the item is, for the line under its name. */
export type InventoryKind =
  | 'model'
  | 'embedding'
  | 'decision'
  | 'image'
  | 'video'
  | 'voice'
  | 'engine'
  /** What a download that never finished left on disk. */
  | 'partial'
  /** A speculative-decoding draft MLX keeps beside the models. */
  | 'draft'

/** What removing an item asks of its owner; one entry per owner. */
export type InventoryRemoval =
  | { type: 'model'; modelId: string; provider: string }
  | { type: 'artifact'; artifactId: string }
  | { type: 'embedding'; model: EmbeddingCatalogModel }
  | { type: 'decision'; model: DecisionCatalogModel }
  | { type: 'voice' }
  | {
      type: 'engine-build'
      engine: EngineId
      version: string
      variant: string
    }
  /** Partial files on disk, refused while a download for `downloadId` runs or waits to resume. */
  | { type: 'partial'; paths: string[]; downloadId: string }
  /** A draft folder, refused while MLX speculative decoding is on. */
  | { type: 'draft'; path: string }

/** A download still running: the panel's row, which the page offers to cancel. */
export type InventoryDownload = {
  /** The download store key the global panel cancels by. */
  id: string
  name: string
  current: number
  total: number
  /** 0..1 */
  progress: number
  /** What the downloader does while it has no bytes to report. */
  stage?: DownloadProgressProps['stage']
  paused: boolean
}

export type InventoryItem = {
  /** Unique across the whole list. */
  key: string
  category: InventoryCategory
  kind: InventoryKind
  /** The human name, shown once. */
  name: string
  /** Facts for the line under the name: quant, engine, build variant. */
  details: string[]
  /** Bytes on disk, or `null` when the source does not say. */
  bytes: number | null
  /**
   * Files the bytes are made of, for items that share files (image and video
   * checkpoints share their encoders): the total counts each file once.
   */
  files?: { path: string; bytes: number }[]
  /** `null` for a download still running. */
  removal: InventoryRemoval | null
  /** Set when the owner refuses removal; the core's reason for an engine build. */
  notRemovableReason?: EngineNotRemovableReason
  /** Set while removal would break something running: a draft MLX may load. */
  removalBlocked?: 'draftInUse'
  /** Set while the item is still downloading. */
  download?: InventoryDownload
}

const validBytes = (bytes: number | undefined | null): number | null =>
  typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
    ? bytes
    : null

const modelName = (model: Model): string =>
  model.displayName || model.name || model.id

/**
 * Model files the local engines registered. The fork and the upstream build
 * read one models directory, so a file both list is one row (the first
 * provider, as the Hub resolves it); MLX shares that id space, the managed
 * engines' shared store and Foundry Local keep their own. The voice model is
 * left to its own row and the app's retrieval model is not the user's.
 */
export function providerModelItems(
  providers: readonly ModelProvider[]
): InventoryItem[] {
  const modelsOf = (name: string) =>
    providers.find((provider) => provider.provider === name)?.models ?? []

  const groups: { group: string; providers: string[] }[] = [
    { group: 'local', providers: [...LLAMACPP_PROVIDERS, MLX_PROVIDER] },
    { group: 'managed', providers: managedProviderIds() },
    { group: 'foundry', providers: [FOUNDRY_LOCAL_PROVIDER] },
  ]

  const items: InventoryItem[] = []
  for (const { group, providers: names } of groups) {
    const seen = new Set<string>()
    for (const provider of names) {
      for (const model of modelsOf(provider)) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        if (model.id === EMBEDDING_MODEL_ID) continue
        if (provider === VOICE_PROVIDER && model.id === VOICE_MODEL_ID) continue
        items.push({
          key: `model:${group}:${model.id}`,
          category: 'local',
          kind: model.embedding ? 'embedding' : 'model',
          name: modelName(model),
          details: [getProviderTitle(provider)],
          bytes: validBytes(model.sizeBytes),
          removal: { type: 'model', modelId: model.id, provider },
        })
      }
    }
  }
  return items
}

/**
 * Fill in the sizes the engines did not record from what is on disk: an MLX
 * model's `model.yml` says `size_bytes: 0` for every Hub download, which left
 * its row at "—" and out of the total.
 */
export function withMeasuredSizes(
  items: InventoryItem[],
  mlxModelBytes: Record<string, number>
): InventoryItem[] {
  return items.map((item) => {
    const removal = item.removal
    if (
      item.bytes !== null ||
      removal?.type !== 'model' ||
      removal.provider !== MLX_PROVIDER
    ) {
      return item
    }
    const bytes = validBytes(mlxModelBytes[removal.modelId])
    return bytes === null ? item : { ...item, bytes }
  })
}

/** The ids the download store holds a download under: running, starting, paused or resumable. */
export function activeDownloadIds(state: {
  downloads: Record<string, Pick<DownloadProgressProps, 'id' | 'name'>>
  localDownloadingModels: ReadonlySet<string>
  pausedDownloads: ReadonlySet<string>
  resumableDownloads: ReadonlySet<string>
}): string[] {
  const ids = new Set<string>()
  for (const [key, entry] of Object.entries(state.downloads)) {
    for (const id of [key, entry.id, entry.name]) if (id) ids.add(id)
  }
  for (const set of [
    state.localDownloadingModels,
    state.pausedDownloads,
    state.resumableDownloads,
  ]) {
    for (const id of set) ids.add(id)
  }
  return [...ids]
}

/**
 * A download id the way its folder is named: lower case, the characters a task
 * id may not carry as `_`, without a provider prefix (`mlx/…`, `llamacpp-upstream/…`)
 * or a drafter tag (`mlx/dflash:<repo>`).
 */
const folderKey = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9_/:-]/g, '_')
    .replace(/^.*:/, '')
    .replace(/^(llamacpp|llamacpp-upstream|atomic-prism|mlx)\//, '')

/**
 * Whether a download the app holds writes into the folder `partialId`. Erring
 * towards "yes": a folder that only might be a running download's is left alone.
 */
export function isDownloadActive(
  partialId: string,
  activeIds: readonly string[]
): boolean {
  const folder = folderKey(partialId)
  return activeIds.some((id) => {
    const key = folderKey(id)
    return key !== '' && (key.startsWith(folder) || folder.startsWith(key))
  })
}

/** Whether MLX loads a draft with its next model: one of its drafter switches is on. */
export function mlxDraftersOn(providers: readonly ModelProvider[]): boolean {
  const mlx = providers.find((provider) => provider.provider === MLX_PROVIDER)
  return (mlx?.settings ?? []).some(
    (setting) =>
      ['dflash_enabled', 'mtp_enabled', 'eagle3_enabled'].includes(
        setting.key
      ) && Boolean((setting.controller_props as { value?: unknown })?.value)
  )
}

const rootEngine = (root: DownloadRoot): string =>
  getProviderTitle(root === LLAMACPP_MODELS_ROOT ? 'llamacpp-upstream' : 'mlx')

/**
 * Downloads that never finished, from the disk, without the ones the app is
 * still running or can resume: their partial files are what a resume needs.
 */
export function partialDownloadItems(
  partials: readonly PartialDownload[],
  activeIds: readonly string[]
): InventoryItem[] {
  return partials
    .filter((partial) => !isDownloadActive(partial.id, activeIds))
    .map((partial) => ({
      key: `partial:${partial.root}:${partial.id}`,
      category: 'local' as const,
      kind: 'partial' as const,
      name: partial.id,
      details: [rootEngine(partial.root)],
      bytes: validBytes(partial.bytes),
      removal: {
        type: 'partial' as const,
        paths: partial.paths,
        downloadId: partial.id,
      },
    }))
}

/** MLX drafts on disk; not removable while a drafter switch would load one. */
export function draftItems(
  drafts: readonly MlxDraft[],
  draftersOn: boolean
): InventoryItem[] {
  return drafts.map((draft) => ({
    key: `draft:${draft.path}`,
    category: 'local' as const,
    kind: 'draft' as const,
    name: draft.id,
    details: [getProviderTitle(MLX_PROVIDER)],
    bytes: validBytes(draft.bytes),
    removal: { type: 'draft' as const, path: draft.path },
    ...(draftersOn ? { removalBlocked: 'draftInUse' as const } : {}),
  }))
}

/** The voice model, sized by what its engine recorded. */
export function voiceItem(
  providers: readonly ModelProvider[],
  installed: boolean
): InventoryItem | null {
  if (!installed) return null
  const model = providers
    .find((provider) => provider.provider === VOICE_PROVIDER)
    ?.models.find((entry) => entry.id === VOICE_MODEL_ID)
  return {
    key: `voice:${VOICE_MODEL_ID}`,
    category: 'voice',
    kind: 'voice',
    name: VOICE_MODEL_NAME,
    details: [getProviderTitle(VOICE_PROVIDER)],
    bytes: validBytes(model?.sizeBytes) ?? VOICE_MODEL_BYTES,
    removal: { type: 'voice' },
  }
}

/**
 * Image and video checkpoints whose transformer is on disk, sized by the
 * files of each that are present. Shared encoders appear under every
 * checkpoint that needs them; `files` lets the total count them once.
 */
export function artifactItems(
  catalog: DiffusionCatalog | null,
  installed: readonly InstalledArtifact[],
  modelFiles: DiffusionModelFile[]
): InventoryItem[] {
  if (!catalog) return []
  const items: InventoryItem[] = []
  for (const artifact of installed) {
    const family = findFamily(catalog, artifact.family)
    const quant = family ? findQuant(family, artifact.quantId) : undefined
    if (!family || !quant) continue
    const files = planArtifactDownload(family, quant.id, modelFiles, '')
      .entries.filter((entry) => entry.present)
      .map((entry) => ({ path: entry.relativePath, bytes: entry.bytes }))
    const modality = family.modality === 'video' ? 'video' : 'image'
    items.push({
      key: `artifact:${artifact.id}`,
      category: modality,
      kind: modality,
      name: family.name,
      details: [quant.label],
      bytes: validBytes(files.reduce((sum, file) => sum + file.bytes, 0)),
      files,
      removal: { type: 'artifact', artifactId: artifact.id },
    })
  }
  return items
}

/** Catalog embedding models with every file on disk. */
export function embeddingItems(
  models: readonly EmbeddingCatalogModel[],
  installed: Record<string, boolean>
): InventoryItem[] {
  return models
    .filter((model) => installed[model.id])
    .map((model) => ({
      key: `embedding:${model.id}`,
      category: 'local' as const,
      kind: 'embedding' as const,
      name: model.name,
      details: [embeddingQuantLabel(model)],
      bytes: validBytes(embeddingDiskBytes(model)),
      removal: { type: 'embedding' as const, model },
    }))
}

/**
 * Catalog decision models with every file on disk, sized by the downloaded
 * checkpoint; the GGUF the engine may convert a checkpoint into is the core's
 * cache and is not counted.
 */
export function decisionItems(
  models: readonly DecisionCatalogModel[],
  installed: Record<string, boolean>
): InventoryItem[] {
  return models
    .filter((model) => installed[model.id])
    .map((model) => ({
      key: `decision:${model.id}`,
      category: 'local' as const,
      kind: 'decision' as const,
      name: model.name,
      details: [decisionQuantLabel(model)].filter((detail): detail is string =>
        Boolean(detail)
      ),
      bytes: validBytes(decisionCheckpointBytes(model)),
      removal: { type: 'decision' as const, model },
    }))
}

/**
 * Every installed build of every engine, from the core's versions answer.
 * The core reports no size for an installed build, so `bytes` is `null`.
 */
export function engineBuildItems(
  engines: Partial<Record<EngineId, EngineVersions>>
): InventoryItem[] {
  const items: InventoryItem[] = []
  for (const engine of ENGINE_IDS) {
    for (const build of engines[engine]?.builds ?? []) {
      items.push({
        key: `engine:${engine}:${build.version}:${build.variant}`,
        category: 'engine',
        kind: 'engine',
        name: getProviderTitle(engine),
        details: [build.version, build.variant],
        bytes: null,
        removal: {
          type: 'engine-build',
          engine,
          version: build.version,
          variant: build.variant,
        },
        ...(build.removable
          ? {}
          : {
              notRemovableReason: build.not_removable_reason ?? 'active',
            }),
      })
    }
  }
  return items
}

type DownloadSources = {
  downloads: Record<string, DownloadProgressProps>
  localDownloadingModels: ReadonlySet<string>
  pausedDownloads: ReadonlySet<string>
  /** The Hub card a managed or Foundry Local download was started from. */
  downloadOriginByModelId: Record<string, string>
  diffusionCatalog: DiffusionCatalog | null
  embeddingModels: readonly EmbeddingCatalogModel[]
  decisionModels: readonly DecisionCatalogModel[]
}

/** Where a running download lands once it finishes, and its name meanwhile. */
function describeDownload(
  id: string,
  sources: DownloadSources
): Pick<InventoryItem, 'category' | 'kind' | 'name' | 'details'> {
  const diffusion = sources.diffusionCatalog
    ? resolveDiffusionDownloadTaskId(sources.diffusionCatalog, id)
    : null
  if (diffusion) {
    const modality = diffusion.family.modality === 'video' ? 'video' : 'image'
    return {
      category: modality,
      kind: modality,
      name: diffusion.family.name,
      details: [diffusion.quant.label],
    }
  }
  if (isDiffusionModelDownloadTaskId(id)) {
    return { category: 'image', kind: 'image', name: id, details: [] }
  }
  if (
    isDiffusionEngineTaskId(id) ||
    isEngineBuildTaskId(id) ||
    isEngineUpdateTaskId(id) ||
    id.startsWith('llamacpp')
  ) {
    return { category: 'engine', kind: 'engine', name: id, details: [] }
  }
  if (id === VOICE_MODEL_ID) {
    return {
      category: 'voice',
      kind: 'voice',
      name: VOICE_MODEL_NAME,
      details: [],
    }
  }
  if (isEmbeddingDownloadTaskId(id)) {
    const model = sources.embeddingModels.find(
      (entry) => embeddingDownloadTaskId(entry.id) === id
    )
    return {
      category: 'local',
      kind: 'embedding',
      name: model?.name ?? id,
      details: [],
    }
  }
  if (isDecisionDownloadTaskId(id)) {
    const model = sources.decisionModels.find(
      (entry) => decisionDownloadTaskId(entry.id) === id
    )
    return {
      category: 'local',
      kind: 'decision',
      name: model?.name ?? id,
      details: [],
    }
  }
  const origin =
    (isManagedDownloadId(id) || isFoundryLocalDownloadId(id)) &&
    sources.downloadOriginByModelId[id]
  return {
    category: 'local',
    kind: 'model',
    name: origin || id,
    details: [],
  }
}

/**
 * The downloads still running, as the global panel lists them: those with
 * progress, then those started but not yet reporting.
 */
export function downloadItems(sources: DownloadSources): InventoryItem[] {
  const items: InventoryItem[] = []
  const seen = new Set<string>()
  for (const [storeKey, entry] of Object.entries(sources.downloads)) {
    const id = entry.id || entry.name || storeKey
    if (seen.has(id)) continue
    seen.add(id)
    items.push({
      key: `download:${id}`,
      ...describeDownload(id, sources),
      bytes: null,
      removal: null,
      download: {
        id,
        name: entry.name || id,
        current: entry.current ?? 0,
        total: entry.total ?? 0,
        progress: entry.progress ?? 0,
        ...(entry.stage ? { stage: entry.stage } : {}),
        paused: sources.pausedDownloads.has(id),
      },
    })
  }
  for (const id of sources.localDownloadingModels) {
    if (seen.has(id)) continue
    seen.add(id)
    items.push({
      key: `download:${id}`,
      ...describeDownload(id, sources),
      bytes: null,
      removal: null,
      download: {
        id,
        name: id,
        current: 0,
        total: 0,
        progress: 0,
        paused: sources.pausedDownloads.has(id),
      },
    })
  }
  return items
}

/**
 * Bytes on disk across the list. Files an item lists are counted once, however
 * many items share them; an item without a size adds nothing.
 */
export function inventoryTotalBytes(items: readonly InventoryItem[]): number {
  const files = new Map<string, number>()
  let total = 0
  for (const item of items) {
    if (item.download) continue
    if (item.files) {
      for (const file of item.files) files.set(file.path, file.bytes)
    } else {
      total += item.bytes ?? 0
    }
  }
  for (const bytes of files.values()) total += bytes
  return total
}

const CATEGORY_ORDER = new Map(
  INVENTORY_CATEGORIES.map((category, index) => [category, index])
)

/** Running downloads first, then by category, then by name. */
export function sortInventory(items: InventoryItem[]): InventoryItem[] {
  return [...items].sort(
    (a, b) =>
      Number(Boolean(b.download)) - Number(Boolean(a.download)) ||
      (CATEGORY_ORDER.get(a.category) ?? 0) -
        (CATEGORY_ORDER.get(b.category) ?? 0) ||
      a.name.localeCompare(b.name)
  )
}
