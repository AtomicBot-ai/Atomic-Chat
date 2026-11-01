/**
 * Audio models on disk and on the wire: planning a download, turning a catalog
 * model into the core's load request and a form into a job.
 *
 * A model is one catalog entry with one quant, on the wire `<id>:<quant id>`.
 * Its GGUF lives at `<dataFolder>/audio/models/<filename>`, downloaded from the
 * entry's immutable Hugging Face revision through the ordinary download
 * pipeline (`services/diffusion/transfer.ts`), so the download panel, the proxy
 * setting and the Rust size and sha256 checks all apply. The core only lists
 * and deletes these files and is told which one to serve.
 *
 * What a model takes comes from its catalog `controls`, never from its id: a
 * field a model does not list is neither shown nor sent, because audio.cpp
 * refuses an option the family does not declare.
 */

import { getServiceHub } from '@/hooks/useServiceHub'
import { parseSeedText } from '@/hooks/useImageForm'
import { hfResolveUrl } from '@/lib/diffusion/models'
import {
  audioModelsOf,
  findAudioModel,
  recommendedAudioQuant,
  type AudioCatalog,
  type AudioCatalogModel,
  type AudioCatalogQuant,
  type AudioControl,
} from '@/services/audio-catalog-registry'
import type {
  AudioCapabilities,
  AudioGenerateRequest,
  AudioMode,
  AudioModelFile,
  LoadAudioModelRequest,
} from '@/services/audio/types'
import {
  downloadProxyConfig,
  emitTransferError,
  emitTransferProgress,
  emitTransferSuccess,
  emitTransferValidationFailed,
  isTransferValidationError,
  sanitizeTaskId,
  transferFiles,
  type TransferItem,
} from '@/services/diffusion/transfer'

export { AUDIO_MODES } from '@/services/audio/types'
export type { AudioMode } from '@/services/audio/types'

/** Relative: the downloader resolves it against the data folder. */
export const AUDIO_MODELS_DIR = 'audio/models'

/** What the studio knows when a model does not say. */
const FALLBACK_DURATION_SEC: Record<AudioMode, number> = {
  speech: 10,
  music: 10,
  effects: 5,
}
const FALLBACK_DURATION_RANGE: [number, number] = [1, 60]
export const SPEED_RANGE: [number, number] = [0.5, 1.5]

export type AudioSettings = {
  /** The catalog id of the mode's model; empty until the catalog is read. */
  modelId: string
  prompt: string
  /** Speech: a voice the loaded model lists; empty is the model's default. */
  voice: string
  speed: number
  language: string
  instruct: string
  lyrics: string
  durationSec: number
  /** Digits; empty lets the engine choose. */
  bpm: string
  /** Digits; empty is the model's own count. */
  steps: string
  negativePrompt: string
  /** Digits; empty lets the core draw one. */
  seed: string
  /** How the player treats this mode's clips. Never sent: no engine has such a parameter. */
  loop: boolean
}

const blank = {
  modelId: '',
  voice: '',
  speed: 1,
  language: '',
  instruct: '',
  lyrics: '',
  bpm: '',
  steps: '',
  negativePrompt: '',
  seed: '',
  loop: false,
}

/** Each mode's form before its model is known. */
export const AUDIO_DEFAULTS: Record<AudioMode, AudioSettings> = {
  speech: {
    ...blank,
    prompt: 'A small idea can be the start of something wonderful.',
    durationSec: FALLBACK_DURATION_SEC.speech,
  },
  music: {
    ...blank,
    prompt: 'Warm ambient chords with a soft, unhurried melody.',
    durationSec: FALLBACK_DURATION_SEC.music,
  },
  effects: {
    ...blank,
    prompt: 'A soft electronic chime, bright and spacious.',
    durationSec: FALLBACK_DURATION_SEC.effects,
  },
}

export const audioControlShown = (
  model: AudioCatalogModel | undefined,
  control: AudioControl
): boolean => model?.controls.includes(control) ?? false

/** The seconds a model's duration field runs over. */
export const audioDurationRange = (
  model: AudioCatalogModel | undefined
): [number, number] => model?.ranges?.durationSec ?? FALLBACK_DURATION_RANGE

/** The form with `model`'s numbers. What the user wrote stays. */
export function adoptAudioModel(
  current: AudioSettings,
  model: AudioCatalogModel
): AudioSettings {
  const [min, max] = audioDurationRange(model)
  const duration =
    model.defaults.durationSec ?? FALLBACK_DURATION_SEC[model.mode]
  const { seed, speed, bpm } = model.defaults
  return {
    ...current,
    modelId: model.id,
    voice: '',
    speed: speed ?? 1,
    durationSec: Math.min(Math.max(duration, min), max),
    bpm: bpm === undefined ? '' : String(bpm),
    steps: '',
    seed: seed === undefined ? '' : String(seed),
  }
}

/** A mode's settings put back to its model's defaults; its text and model stay. */
export function resetAudioSettings(
  current: AudioSettings,
  model: AudioCatalogModel | undefined
): AudioSettings {
  return {
    ...(model ? adoptAudioModel(current, model) : current),
    loop: false,
  }
}

/** The mode's model and the quant it runs, when the catalog lists it. */
export function audioTargetOf(
  catalog: AudioCatalog | null,
  settings: AudioSettings
): { model: AudioCatalogModel; quant: AudioCatalogQuant } | null {
  const model = catalog ? findAudioModel(catalog, settings.modelId) : undefined
  return model ? { model, quant: recommendedAudioQuant(model) } : null
}

/**
 * The forms once a catalog is known: a mode whose model is unset or gone from
 * the catalog takes the mode's first model, which is its default.
 */
export function formsForCatalog(
  forms: Record<AudioMode, AudioSettings>,
  catalog: AudioCatalog
): Record<AudioMode, AudioSettings> {
  const next = { ...forms }
  for (const mode of Object.keys(forms) as AudioMode[]) {
    if (findAudioModel(catalog, forms[mode].modelId)) continue
    const first = audioModelsOf(catalog, mode)[0]
    if (first) next[mode] = adoptAudioModel(forms[mode], first)
  }
  return next
}

/** `<id>:<quant id>`: the core's model id, and the catalog's. */
export const audioWireId = (
  model: AudioCatalogModel,
  quant: AudioCatalogQuant
): string => `${model.id}:${quant.id}`

/** The catalog id of a wire id, which is what names a model on a result. */
export const audioCatalogIdOf = (wireId: string): string => wireId.split(':')[0]

/** A clip's model as the catalog knows it, for the notice its license asks for. */
export const audioAttributionOf = (
  catalog: AudioCatalog | null,
  wireId: string
): string | null =>
  (catalog && findAudioModel(catalog, audioCatalogIdOf(wireId))?.attribution) ||
  null

/**
 * The core's load request. The file is named relative to the models folder and
 * `defaultVoice` carries a model that refuses a request with no voice.
 */
export function buildAudioLoadRequest(
  model: AudioCatalogModel,
  quant: AudioCatalogQuant
): LoadAudioModelRequest {
  return {
    modelId: audioWireId(model, quant),
    displayName: model.name,
    mode: model.mode,
    file: quant.filename,
    family: model.family,
    task: model.task,
    ...(model.load_options ? { loadOptions: model.load_options } : {}),
    ...(model.session_options ? { sessionOptions: model.session_options } : {}),
    ...(model.default_request_options
      ? { defaultRequestOptions: model.default_request_options }
      : {}),
    ...(model.default_voice ? { defaultVoice: model.default_voice } : {}),
  }
}

const positiveIntOf = (text: string): number | undefined => {
  const value = Number(text.trim())
  return text.trim() !== '' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

/**
 * The job the form describes. Only what the model lists goes out, and text left
 * empty stays out. `durationSec` always goes for music and effects: without one
 * Stable Audio renders its 120-second default.
 */
export function buildAudioRequest(
  model: AudioCatalogModel,
  settings: AudioSettings
): AudioGenerateRequest {
  const has = (control: AudioControl) => model.controls.includes(control)
  const text = (value: string) => {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  const voice = has('voice') ? text(settings.voice) : undefined
  const language = has('language') ? text(settings.language) : undefined
  const instruct = has('instruct') ? text(settings.instruct) : undefined
  const lyrics = has('lyrics') ? text(settings.lyrics) : undefined
  const negativePrompt = has('negativePrompt')
    ? text(settings.negativePrompt)
    : undefined
  const bpm = has('bpm') ? positiveIntOf(settings.bpm) : undefined
  const steps = has('steps') ? positiveIntOf(settings.steps) : undefined
  const seed = has('seed') ? parseSeedText(settings.seed) : null
  return {
    text: settings.prompt.trim(),
    ...(voice ? { voice } : {}),
    ...(has('speed') ? { speed: settings.speed } : {}),
    ...(language ? { language } : {}),
    ...(instruct ? { instruct } : {}),
    ...(lyrics ? { lyrics } : {}),
    ...(model.mode !== 'speech' || has('durationSec')
      ? { durationSec: settings.durationSec }
      : {}),
    ...(bpm ? { bpm } : {}),
    ...(steps ? { steps } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(seed !== null ? { seed } : {}),
  }
}

/** A built-in voice id as the voice list shows it: `uncle_fu` → `Uncle Fu`. */
export const audioVoiceLabel = (voice: string): string =>
  voice
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

/** Whether the core lists the quant's file, whole. */
export const isAudioQuantOnDisk = (
  quant: AudioCatalogQuant,
  files: readonly AudioModelFile[]
): boolean =>
  files.some(
    (file) => file.relativePath === quant.filename && file.bytes === quant.bytes
  )

const AUDIO_TASK_PREFIX = 'audio-model-'

/** Download panel row and Rust task id. */
export const audioDownloadTaskId = (wireId: string): string =>
  `${AUDIO_TASK_PREFIX}${sanitizeTaskId(wireId)}`

export const isAudioDownloadTaskId = (taskId: string): boolean =>
  taskId.startsWith(AUDIO_TASK_PREFIX)

/** The catalog entry behind a sanitized task id, regenerated rather than split. */
export function resolveAudioDownloadTaskId(
  catalog: AudioCatalog | null,
  taskId: string
): { model: AudioCatalogModel; quant: AudioCatalogQuant } | null {
  if (!catalog || !isAudioDownloadTaskId(taskId)) return null
  for (const model of catalog.models) {
    for (const quant of model.quants) {
      if (audioDownloadTaskId(audioWireId(model, quant)) === taskId)
        return { model, quant }
    }
  }
  return null
}

export type AudioDownloadOptions = {
  hfToken?: string
  resume?: boolean
}

/**
 * Download a quant from the model's pinned revision under
 * `audioDownloadTaskId`, resolving once the file is on disk and its size and
 * sha256 have been checked. A partial left by an earlier try is picked up.
 */
export async function downloadAudioModel(
  model: AudioCatalogModel,
  quant: AudioCatalogQuant,
  opts: AudioDownloadOptions = {}
): Promise<void> {
  const taskId = audioDownloadTaskId(audioWireId(model, quant))
  const proxy = downloadProxyConfig()
  const item: TransferItem = {
    url: hfResolveUrl(model.repo, quant.path, model.revision),
    save_path: `${AUDIO_MODELS_DIR}/${quant.filename}`,
    ...(proxy ? { proxy } : {}),
    sha256: quant.sha256,
    size: quant.bytes,
    model_id: taskId,
  }
  emitTransferProgress(taskId, 'Model', 0, quant.bytes)
  try {
    await transferFiles([item], taskId, {
      resume: opts.resume ?? true,
      ...(opts.hfToken ? { hfToken: opts.hfToken } : {}),
      onProgress: (transferred, total) =>
        emitTransferProgress(taskId, 'Model', transferred, total),
    })
  } catch (error) {
    if (isTransferValidationError(error)) {
      emitTransferValidationFailed(taskId, error)
    } else {
      emitTransferError(taskId, 'Model', error)
    }
    throw error
  }
  emitTransferSuccess(taskId, 'Model', quant.bytes)
}

/** Remove a quant's file through the core, which refuses the loaded model's. */
export async function deleteAudioQuant(
  quant: AudioCatalogQuant
): Promise<void> {
  await getServiceHub().audio().deleteModelFile(quant.filename)
}

export type AudioGenerateDisabledReason =
  | 'coreTooOld'
  | 'coreUnavailable'
  | 'noEngine'
  | 'noModel'
  | 'modelLoading'
  | 'needsVoiceRef'
  | 'emptyPrompt'

export type AudioGenerateFacts = {
  core: 'checking' | 'ready' | 'too-old' | 'unreachable'
  engineInstalled: boolean
  modelReady: boolean
  modelLoading: boolean
  /** The loaded model's capabilities, when the form's model is the loaded one. */
  capabilities: AudioCapabilities | null
}

/** Why Generate is off, first reason first. Generate itself starts a stopped model. */
export function audioGenerateDisabledReason(
  settings: AudioSettings,
  {
    core,
    engineInstalled,
    modelReady,
    modelLoading,
    capabilities,
  }: AudioGenerateFacts
): AudioGenerateDisabledReason | null {
  if (core === 'too-old') return 'coreTooOld'
  if (core !== 'ready') return 'coreUnavailable'
  if (!engineInstalled) return 'noEngine'
  if (!modelReady) return 'noModel'
  if (modelLoading) return 'modelLoading'
  if (capabilities?.requiresVoiceRef) return 'needsVoiceRef'
  if (!settings.prompt.trim()) return 'emptyPrompt'
  return null
}
