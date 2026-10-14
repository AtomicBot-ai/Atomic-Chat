/**
 * Generate an image or video from the chat composer.
 *
 * The Media page is for fine-tuning; chat is for asking. So this reuses what
 * the user last tuned for the task, swaps in the new prompt, runs the job
 * through the same job manager the Media page uses, and puts the result in the
 * same library - so a chat generation shows up under Media > Library and can be
 * saved, renamed and re-run like any other.
 */

import { ulid } from 'ulidx'

import {
  mediaJobManager,
  isTerminalMediaJobState,
  type MediaJobEntry,
  type MediaJobManager,
} from './jobManager'
import { materialize, type MaterializeDeps, type MediaAsset } from './assets'
import type {
  MediaCapabilities,
  MediaModelDescriptor,
  MediaParamOption,
  MediaParamSpec,
  MediaProviderDescriptor,
  NormalizedMediaRequest,
} from './contract'
import type { MediaLastUsed } from '@/stores/media-last-used-store'

export type ChatMediaTaskId = 'text_to_image' | 'text_to_video'

/**
 * What the chat generation popup lets the user override on top of the
 * "use last used settings" default. `useLastUsed: false` means the request is
 * built from the model's defaults plus these explicit choices, never from the
 * Media page's remembered settings.
 */
export type ChatMediaOverrides = {
  useLastUsed?: boolean
  /** Resolution preset value (`1024x1024`) or the sentinel `'highest'`. */
  resolution?: string
  /** Video length in seconds. Ignored for images and when using last used. */
  length_seconds?: number
  /**
   * Continue the most recent video: its last frame becomes the new clip's
   * first frame. Only for `text_to_video`; overrides the other choices.
   */
  continueLastVideo?: boolean
}

/** The choices the chat popup can offer for a task, before any prompt. */
export type ChatMediaSettings = {
  model: MediaModelDescriptor
  resolutionOptions: MediaParamOption[]
  /** The largest offered resolution, or `undefined` when there is none. */
  highestResolution: string | undefined
  lengthOptions: MediaParamOption[]
  defaults: Record<string, unknown>
  lastUsed?: MediaLastUsed
}

export type ChatGenerationDeps = {
  manager: MediaJobManager
  providers: () => MediaProviderDescriptor[]
  capabilities: () => Record<string, MediaCapabilities>
  refresh: () => Promise<void>
  lastUsed: (task: string) => MediaLastUsed | undefined
  materializeDeps: MaterializeDeps
  addToLibrary: (assets: MediaAsset[]) => Promise<void>
  newId: () => string
  appVersion: string
  /** Every asset in the library, for "continue last video". */
  assets: () => MediaAsset[]
  /** Reads a stored video's last frame as a JPEG data URL. */
  extractLastFrame: (path: string, mime: string) => Promise<string>
}

export type ChatGenerationResult = {
  assets: MediaAsset[]
  request: NormalizedMediaRequest
  model_label: string
}

/** What a user sees when there is nothing to generate with. */
export class NoMediaModelError extends Error {
  constructor(task: string) {
    super(
      task === 'text_to_video'
        ? 'No video model is set up. Open Media, pick a video model and generate once.'
        : 'No image model is set up. Open Media, pick an image model and generate once.'
    )
    this.name = 'NoMediaModelError'
  }
}

/** What a user sees when they ask to continue but no video exists yet. */
export class NoVideoToContinueError extends Error {
  constructor() {
    super('No video to continue yet. Generate a video first.')
    this.name = 'NoVideoToContinueError'
  }
}

function modelsFor(
  task: string,
  providers: MediaProviderDescriptor[],
  capabilities: Record<string, MediaCapabilities>
): MediaModelDescriptor[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => capabilities[provider.id]?.models ?? [])
    .filter((model) => model.tasks.includes(task))
}

function defaultsOf(model: MediaModelDescriptor, task: string) {
  const values: Record<string, unknown> = {}
  for (const spec of model.params?.[task] ?? []) {
    if (spec?.default !== undefined) values[spec.id] = spec.default
  }
  return values
}

function specsOf(model: MediaModelDescriptor, task: string): MediaParamSpec[] {
  return model.params?.[task] ?? []
}

function optionsOf(specs: MediaParamSpec[], id: string): MediaParamOption[] {
  const spec = specs.find((entry) => entry.id === id)
  return spec?.options ?? []
}

/**
 * The resolution options a renderer should offer. Prefer a spec of type
 * `resolution` (paired width/height); fall back to any spec literally named
 * `resolution` so adapters that express it as an enum still work.
 */
function resolutionOptionsOf(specs: MediaParamSpec[]): MediaParamOption[] {
  const byType = specs.find(
    (spec) => spec.type === 'resolution' && (spec.options?.length ?? 0) > 0
  )
  if (byType) return byType.options ?? []
  return optionsOf(specs, 'resolution')
}

/** Largest option by area; `undefined` when there is nothing to compare. */
function highestOf(options: MediaParamOption[]): string | undefined {
  let best: MediaParamOption | undefined
  let bestArea = -1
  for (const option of options) {
    const area = (option.width ?? 0) * (option.height ?? 0)
    if (area > bestArea) {
      bestArea = area
      best = option
    }
  }
  return best ? String(best.value) : undefined
}

function highestResolutionFor(model: MediaModelDescriptor, task: string) {
  return highestOf(resolutionOptionsOf(specsOf(model, task)))
}

/**
 * The model and resolution/length choices the chat popup can offer for a task.
 * Reuses the exact resolution that `resolveChatRequest` would run, so the
 * popup and the runner can never disagree on which model is used.
 */
export function chatMediaSettingsFor(
  task: string,
  deps: Pick<ChatGenerationDeps, 'providers' | 'capabilities' | 'lastUsed'>
): ChatMediaSettings {
  const candidates = modelsFor(task, deps.providers(), deps.capabilities())
  if (candidates.length === 0) throw new NoMediaModelError(task)

  const last = deps.lastUsed(task)
  const remembered = last
    ? candidates.find((model) => model.id === last.model_id)
    : undefined
  // Prefer something that can run now over something that needs downloading.
  const model =
    remembered ??
    candidates.find((entry) => entry.install?.installed !== false) ??
    candidates[0]!

  const specs = specsOf(model, task)
  const resolutionOptions = resolutionOptionsOf(specs)
  return {
    model,
    resolutionOptions,
    highestResolution: highestOf(resolutionOptions),
    lengthOptions: optionsOf(specs, 'length_seconds'),
    defaults: defaultsOf(model, task),
    ...(remembered && last ? { lastUsed: last } : {}),
  }
}

/**
 * The model and parameters to use: the last used ones if that model is still
 * available, otherwise the first usable model with its own defaults, overlaid
 * with any explicit chat-popup overrides (`resolution`, `length_seconds`).
 *
 * Overrides only apply when the remembered settings are not being used: a
 * checked "use last used settings" is authoritative, and the popup's own
 * controls are hidden then.
 */
export function resolveChatRequest(
  task: string,
  prompt: string,
  deps: Pick<
    ChatGenerationDeps,
    'providers' | 'capabilities' | 'lastUsed' | 'newId'
  >,
  overrides: ChatMediaOverrides = {}
): { request: NormalizedMediaRequest; model: MediaModelDescriptor } {
  const candidates = modelsFor(task, deps.providers(), deps.capabilities())
  if (candidates.length === 0) throw new NoMediaModelError(task)

  const useLastUsed = overrides.useLastUsed !== false
  const last = useLastUsed ? deps.lastUsed(task) : undefined
  const remembered = last
    ? candidates.find((model) => model.id === last.model_id)
    : undefined
  // Prefer something that can run now over something that needs downloading.
  const model =
    remembered ??
    candidates.find((entry) => entry.install?.installed !== false) ??
    candidates[0]!

  const params: Record<string, unknown> = remembered
    ? { ...defaultsOf(model, task), ...last?.params, prompt }
    : { ...defaultsOf(model, task), prompt }

  if (!remembered) {
    if (overrides.resolution) {
      const resolution =
        overrides.resolution === 'highest'
          ? highestResolutionFor(model, task)
          : overrides.resolution
      if (resolution) params.resolution = resolution
    }
    if (task === 'text_to_video' && overrides.length_seconds !== undefined) {
      params.length_seconds = overrides.length_seconds
    }
  }

  return {
    model,
    request: {
      client_job_id: deps.newId(),
      provider_id: model.provider_id,
      model_id: model.id,
      task,
      params,
      ...(remembered && last?.device ? { device: last.device } : {}),
    },
  }
}

/**
 * Continue the most recent video from the chat prompt: find it, read its last
 * frame, and run its own model again with that frame as `init_image` and the
 * new prompt. The old `end_image` and `seed` are dropped, mirroring the
 * library's Continue button.
 */
export async function resolveChatContinueRequest(
  task: string,
  prompt: string,
  deps: Pick<
    ChatGenerationDeps,
    'capabilities' | 'newId' | 'assets' | 'extractLastFrame'
  >
): Promise<{ request: NormalizedMediaRequest; model: MediaModelDescriptor }> {
  if (task !== 'text_to_video') throw new NoVideoToContinueError()

  const latest = deps
    .assets()
    .filter((asset) => asset.media_type === 'video')
    .sort((a, b) => b.created_at - a.created_at)[0]
  if (!latest) throw new NoVideoToContinueError()

  const providerCaps = deps.capabilities()[latest.provenance.provider_id]
  const model = providerCaps?.models?.find(
    (entry) => entry.id === latest.provenance.model_id
  )
  if (!model) {
    throw new Error('The model that made the last video is no longer available.')
  }

  const initImage = await deps.extractLastFrame(latest.path, latest.mime)
  const params: Record<string, unknown> = {
    ...latest.provenance.params,
    prompt,
    init_image: initImage,
  }
  delete params.end_image
  delete params.seed

  return {
    model,
    request: {
      client_job_id: deps.newId(),
      provider_id: latest.provenance.provider_id,
      model_id: latest.provenance.model_id,
      task,
      params,
      ...(latest.provenance.device ? { device: latest.provenance.device } : {}),
    },
  }
}

/** Resolves when the job reaches a terminal state. */
function untilTerminal(
  manager: MediaJobManager,
  clientJobId: string,
  onUpdate?: (entry: MediaJobEntry) => void,
  signal?: AbortSignal
): Promise<MediaJobEntry> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const entry = manager.get(clientJobId)
      if (!entry) return
      onUpdate?.(entry)
      if (isTerminalMediaJobState(entry.state)) {
        unsubscribe()
        resolve(entry)
      }
    }
    const unsubscribe = manager.store.subscribe(check)
    signal?.addEventListener('abort', () => {
      unsubscribe()
      reject(new DOMException('Generation cancelled', 'AbortError'))
    })
    check()
  })
}

export async function generateMediaForChat(
  task: ChatMediaTaskId,
  prompt: string,
  deps: ChatGenerationDeps,
  options: { onUpdate?: (entry: MediaJobEntry) => void; signal?: AbortSignal } = {},
  overrides: ChatMediaOverrides = {}
): Promise<ChatGenerationResult> {
  // Capabilities are not persisted; a fresh app start has none until asked.
  if (Object.keys(deps.capabilities()).length === 0) await deps.refresh()

  const { request, model } = overrides.continueLastVideo
    ? await resolveChatContinueRequest(task, prompt, deps)
    : resolveChatRequest(task, prompt, deps, overrides)
  await deps.manager.submit(request)
  const entry = await untilTerminal(
    deps.manager,
    request.client_job_id,
    options.onUpdate,
    options.signal
  )

  if (entry.state !== 'succeeded') {
    throw new Error(
      entry.error?.message ??
        (entry.state === 'cancelled'
          ? 'The generation was cancelled.'
          : 'The generation failed.')
    )
  }

  const assets = await materialize(
    entry,
    {
      request: entry.request,
      model_label: model.label,
      app_version: deps.appVersion,
    },
    deps.materializeDeps
  )
  if (assets.length === 0) throw new Error('The provider returned no output.')
  await deps.addToLibrary(assets)
  return { assets, request: entry.request, model_label: model.label }
}

/** The real dependencies. Built lazily so importing this stays side-effect free. */
export async function defaultChatGenerationDeps(): Promise<ChatGenerationDeps> {
  const [
    { useMediaProviderStore },
    { useMediaLastUsedStore },
    library,
    hook,
    { extractLastFrameDataUrl },
  ] = await Promise.all([
    import('@/stores/media-provider-store'),
    import('@/stores/media-last-used-store'),
    import('@/stores/media-library-store'),
    import('@/hooks/useMediaJobAsset'),
    import('@/containers/media/videoLastFrame'),
  ])
  return {
    manager: mediaJobManager,
    providers: () => useMediaProviderStore.getState().providers,
    capabilities: () => useMediaProviderStore.getState().capabilities,
    refresh: () => useMediaProviderStore.getState().refresh(),
    lastUsed: (task) => useMediaLastUsedStore.getState().byTask[task],
    materializeDeps: hook.browserMaterializeDeps,
    addToLibrary: (assets) => library.useMediaLibraryStore.getState().add(assets),
    assets: () => library.useMediaLibraryStore.getState().assets,
    extractLastFrame: extractLastFrameDataUrl,
    newId: () => ulid(),
    appVersion: VERSION,
  }
}
