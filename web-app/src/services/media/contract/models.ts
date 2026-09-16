/**
 * Media contract v2 — models, devices and provider capabilities.
 *
 * Pure types. No I/O, no React.
 */

import type { MediaParamSpec } from './params'
import type {
  MediaOutputMediaType,
  MediaTaskId,
  MediaTaskPresentation,
} from './tasks'

export type MediaFitnessStatus =
  | 'recommended'
  | 'runnable'
  | 'degraded'
  | 'unsupported'

export type MediaFitness = {
  status: MediaFitnessStatus
  reason_key?: string
  reason?: string
  required_device?: string | null
  min_vram_mb?: number
  notes?: string[]
}

export type MediaInstallState = {
  installed: boolean
  /** The provider exposes an install path for this model. */
  installable: boolean
  size_bytes?: number
  version?: string
  update_available?: boolean
  source?: { kind: 'huggingface' | 'url' | 'provider'; ref?: string }
}

/** One size (quantisation) of a model that is offered in several. */
export type MediaModelQuant = {
  /** Descriptors sharing a group are one model, shown together. */
  group_id: string
  group_label: string
  /** As its source names it, such as `Q4_0`. */
  label: string
  note?: string
  /** The size used when none is chosen. */
  is_default?: boolean
}

/** One file a model's download saves. */
export type MediaDownloadFile = {
  name: string
  /** What the file is for, such as `vae` or `diffusion_model`. */
  role: string
  size_bytes: number
  /** Where it comes from, for display. */
  source?: string
  installed?: boolean
}

export type MediaModelDescriptor = {
  /**
   * Globally unique and provider-qualified: `${provider_id}:${local_id}`.
   * Two providers may both expose `sdxl-base`; unqualified ids make the
   * selection state ambiguous the moment a second provider exists, and that
   * ambiguity cannot be fixed later without a data migration.
   */
  id: string
  provider_id: string
  local_id: string

  label: string
  description_key?: string
  /** Display only, e.g. `wan2.2`, `flux`, `sdxl`. Never behavioural. */
  family?: string
  repo?: string

  tasks: MediaTaskId[]
  /**
   * Per-task parameter schema. Every key must appear in `tasks`. Keyed by task
   * because the same model routinely takes different knobs for
   * `image_to_video` than for `text_to_video`; one flat list would force
   * `depends_on` gymnastics onto every entry.
   */
  params: Record<MediaTaskId, MediaParamSpec[]>

  install?: MediaInstallState
  fitness?: MediaFitness
  license?: { id?: string; url?: string; gated?: boolean }
  outputs?: Partial<
    Record<
      MediaTaskId,
      {
        media_type: MediaOutputMediaType
        mime?: string[]
      }
    >
  >
  /** Its size, when the model is offered in several. Display only. */
  quant?: MediaModelQuant
  /** What downloading it saves, file by file. Display only. */
  download_files?: MediaDownloadFile[]
  /** Roughly how much graphics or shared memory it needs. Display only. */
  min_memory_mb?: number
  /** Non-local providers only. Display-only; never used to gate submission. */
  cost?: { unit: 'credit' | 'usd'; per_job?: number; note_key?: string }
}

export type MediaDeviceDescriptor = {
  id: string
  label: string
  backend?: string
  vram_total_mb?: number
  vram_free_mb?: number
}

export type MediaProviderFeatures = {
  cancel?: boolean
  progress?: boolean
  queue?: boolean
  /** SSE/WS streaming available. Must match `MediaProviderAdapter.subscribe`. */
  events?: boolean
  install?: boolean
  batch?: boolean
  /**
   * The provider produces its result in the submit response rather than
   * creating a job that can be queried afterwards - an OpenAI-compatible
   * images endpoint, for example.
   *
   * The rest of the contract still applies: `submit` returns a live snapshot
   * and `poll` reports the outcome, because the caller must not have to know
   * which kind of provider it is holding. What changes is what `poll` *is*.
   * For a job-based provider it is a request; for a synchronous one it reads
   * a result that has already been paid for, and must never reach the network
   * again - a second request would generate, and charge, twice.
   *
   * Declared rather than inferred: a provider with no queue is not necessarily
   * synchronous, and the conformance suite has to know which of the two kinds
   * of `poll` it is testing. Discovered by the third adapter; see the tracker's
   * decision D7.
   */
  synchronous?: boolean
}

export type MediaCapabilities = {
  contract_version: 2
  provider_id: string
  devices: MediaDeviceDescriptor[]
  models: MediaModelDescriptor[]
  /** Presentation metadata for the tasks this provider's models expose. */
  tasks?: MediaTaskPresentation[]
  recommended?: Array<{ task: MediaTaskId; model_id: string }>
  features?: MediaProviderFeatures
}

/** Contract version this build speaks. */
export const MEDIA_CONTRACT_VERSION = 2 as const

/**
 * Version negotiation window (plan section 5.2).
 *
 * A provider reporting 1 is upcast; 2 is used directly. Anything higher must be
 * refused outright rather than partially parsed - a half-understood future
 * contract silently generates with settings the user did not choose.
 */
export const MEDIA_CONTRACT_MIN_SUPPORTED = 1
export const MEDIA_CONTRACT_MAX_SUPPORTED = 2
