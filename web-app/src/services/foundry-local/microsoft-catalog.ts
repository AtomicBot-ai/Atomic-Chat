/**
 * Microsoft's live model catalog, shown under the "Foundry Local" format after conf's curated list
 * (openspec change `add-foundry-local`, design D4.1, spec "Каталог Microsoft дополняет курированный
 * список").
 *
 * `POST <catalog.url>` (Azure ML `asset-gallery`, which answers without an account) with the latest
 * label and the accelerators this app runs, page by page on `continuationToken`. Each entry of the
 * answer is one variant (`<model>-<accelerator>-<device>`) naming its parent model; they are
 * grouped by that parent. Kept: variants offered as "Foundry Local on Devices" for a chat task on a
 * supported accelerator. Speech and embedding models and TensorRT-RTX variants are left out, and so
 * is a variant conf's curated list holds with the same asset id and version — the curated entry,
 * hashed and checked, is the one shown.
 *
 * The catalog has no context length, tool calling or reasoning for these models; the installer
 * reads them from the resolve answer. Files are checked by size only, so the Hub marks these models
 * "Microsoft catalog, not verified by Atomic Chat".
 *
 * Asked once per Hub session (kept in memory, forgotten after a failure). A failure is not an error
 * the Hub shows as one: it gets no models and `unavailable`, and shows the curated list alone.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import type { FoundryLocalModel, FoundryLocalPlatform } from './curated'
import type { FoundryLocalDevice, FoundryLocalExecutionProvider } from './types'

/** The catalog's accelerator names this app runs, and how conf spells them. */
const EXECUTION_PROVIDERS: ReadonlyArray<[string, FoundryLocalExecutionProvider]> = [
  ['CPUExecutionProvider', 'cpu'],
  ['CUDAExecutionProvider', 'cuda'],
  ['WebGPUExecutionProvider', 'webgpu'],
  ['OpenVINOExecutionProvider', 'openvino'],
  ['QNNExecutionProvider', 'qnn'],
  ['VitisAIExecutionProvider', 'vitisai'],
]
const BY_CATALOG_NAME = new Map(EXECUTION_PROVIDERS)

/**
 * Where a catalog variant can run. The catalog does not say, so it follows from the accelerator, as
 * conf's integrity check rules it for curated variants: CUDA on Windows x64 and Linux x64, WebGPU on
 * Windows and Apple Silicon, the NPU plugins on the Windows machines that carry those NPUs. The core's
 * check has the last word on this machine.
 */
const PLATFORMS: Record<FoundryLocalExecutionProvider, FoundryLocalPlatform[]> = {
  cpu: ['win-x64', 'win-arm64', 'macos-arm64', 'linux-x64', 'linux-arm64'],
  cuda: ['win-x64', 'linux-x64'],
  webgpu: ['win-x64', 'win-arm64', 'macos-arm64'],
  openvino: ['win-x64'],
  qnn: ['win-arm64'],
  vitisai: ['win-x64'],
}

const CHAT_TASKS = new Set(['chat-completion', 'vision-language-chat'])
const DEPLOYMENT = 'Foundry Local on Devices'
const PAGE_SIZE = 50
/** The catalog had 254 entries in 2026; a token that never ends must not loop forever. */
const MAX_PAGES = 40

export interface CatalogVariant {
  /** The catalog name lowercased: names the download and the folder, like a curated variant id. */
  id: string
  /** As the catalog spells it. */
  name: string
  asset_id: string
  version: string
  device: FoundryLocalDevice
  execution_provider: FoundryLocalExecutionProvider
  platforms: FoundryLocalPlatform[]
  /** The variant's files together, as the catalog reports them; `null` when it does not. */
  size_bytes: number | null
  license: string | null
}

export interface CatalogModel {
  /** The parent model's name, lowercased. */
  id: string
  /** The parent model's name as the catalog spells it. */
  name: string
  license: string | null
  /** Whether any variant reads images (`vision-language-chat`); images are not attached here. */
  vision: boolean
  variants: CatalogVariant[]
}

export interface MicrosoftCatalogResult {
  models: CatalogModel[]
  /** The catalog could not be read; the Hub says so and shows the curated list alone. */
  unavailable: boolean
  error?: string
}

/** `POST url` with a JSON body, answering the parsed JSON. */
export type CatalogPost = (url: string, body: Record<string, unknown>) => Promise<unknown>

type Summary = {
  assetId?: unknown
  name?: unknown
  version?: unknown
  license?: unknown
  inferenceTasks?: unknown
  deploymentOptions?: unknown
  variantInformation?: {
    parents?: Array<{ assetId?: unknown }>
    variantMetadata?: { device?: unknown; executionProvider?: unknown; fileSizeBytes?: unknown }
  } | null
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `azureml://registries/azureml/models/Phi-3-mini-4k-instruct/versions/15` → `Phi-3-mini-4k-instruct`. */
const modelNameOf = (assetId: string): string | null =>
  /\/models\/([^/]+)\/versions\/[^/]+$/.exec(assetId)?.[1] ?? null

function variantOf(summary: Summary): { parent: string; variant: CatalogVariant; vision: boolean } | null {
  const { assetId, name, version, license, inferenceTasks, deploymentOptions, variantInformation } = summary
  if (typeof assetId !== 'string' || typeof name !== 'string' || typeof version !== 'string') return null
  if (!Array.isArray(deploymentOptions) || !deploymentOptions.includes(DEPLOYMENT)) return null
  const tasks = Array.isArray(inferenceTasks) ? inferenceTasks : []
  if (!tasks.some((task) => CHAT_TASKS.has(task as string))) return null
  const metadata = variantInformation?.variantMetadata
  const parentAsset = variantInformation?.parents?.[0]?.assetId
  if (!metadata || typeof parentAsset !== 'string') return null
  const executionProvider = BY_CATALOG_NAME.get(metadata.executionProvider as string)
  if (!executionProvider) return null
  const device = metadata.device
  if (device !== 'cpu' && device !== 'gpu' && device !== 'npu') return null
  const parent = modelNameOf(parentAsset)
  if (!parent) return null
  const size = metadata.fileSizeBytes
  return {
    parent,
    vision: tasks.includes('vision-language-chat'),
    variant: {
      id: name.toLowerCase(),
      name,
      asset_id: assetId,
      version,
      device,
      execution_provider: executionProvider,
      platforms: PLATFORMS[executionProvider],
      size_bytes: typeof size === 'number' && size > 0 ? size : null,
      license: typeof license === 'string' ? license : null,
    },
  }
}

/** The chat models of the catalog's entries, grouped by parent model, in the order first seen. */
function group(summaries: Summary[], curated: readonly FoundryLocalModel[]): CatalogModel[] {
  const curatedAssets = new Set(
    curated.flatMap((model) =>
      model.variants.map((variant) => `${variant.source.asset_id}@${variant.source.version}`)
    )
  )
  const models = new Map<string, CatalogModel>()
  for (const summary of summaries) {
    const entry = variantOf(summary)
    if (!entry) continue
    const { parent, variant, vision } = entry
    if (curatedAssets.has(`${variant.asset_id}@${variant.version}`)) continue
    const id = parent.toLowerCase()
    const model = models.get(id) ?? { id, name: parent, license: null, vision: false, variants: [] }
    if (model.variants.some((known) => known.id === variant.id)) continue
    model.variants.push(variant)
    model.license ??= variant.license
    model.vision ||= vision
    models.set(id, model)
  }
  return [...models.values()]
}

const defaultPost: CatalogPost = async (url, body) => {
  // The catalog sends no CORS headers for the webview's origin: the Tauri HTTP plugin asks it.
  const fetcher = typeof IS_TAURI !== 'undefined' && IS_TAURI ? (fetchTauri as typeof fetch) : fetch
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Microsoft catalog: ${response.status} ${response.statusText}`)
  return (await response.json()) as unknown
}

async function readAll(url: string, post: CatalogPost): Promise<Summary[]> {
  const filters = [
    { field: 'labels', operator: 'eq', values: ['latest'] },
    {
      field: 'VariantInformation/VariantMetadata/ExecutionProvider',
      operator: 'eq',
      values: EXECUTION_PROVIDERS.map(([name]) => name),
    },
  ]
  const summaries: Summary[] = []
  let token: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await post(url, { filters, pageSize: PAGE_SIZE, ...(token ? { continuationToken: token } : {}) })
    if (!isObject(answer) || !Array.isArray(answer.summaries)) {
      throw new Error('The Microsoft catalog answered in a shape this app does not read.')
    }
    summaries.push(...(answer.summaries as Summary[]))
    token = typeof answer.continuationToken === 'string' && answer.continuationToken ? answer.continuationToken : undefined
    if (!token || answer.summaries.length === 0) break
  }
  return summaries
}

/** What this Hub session read, per catalog URL; a failure is not kept. */
const session = new Map<string, Promise<Summary[]>>()

export function resetMicrosoftCatalogForTests(): void {
  session.clear()
}

export async function fetchMicrosoftCatalog(options: {
  url: string
  curated: readonly FoundryLocalModel[]
  post?: CatalogPost
}): Promise<MicrosoftCatalogResult> {
  const { url, curated } = options
  let read = session.get(url)
  if (!read) {
    read = readAll(url, options.post ?? defaultPost)
    session.set(url, read)
  }
  try {
    return { models: group(await read, curated), unavailable: false }
  } catch (error) {
    session.delete(url)
    return {
      models: [],
      unavailable: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
