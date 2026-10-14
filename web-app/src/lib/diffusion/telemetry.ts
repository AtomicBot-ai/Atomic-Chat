/**
 * PostHog events for local image generation.
 *
 * Same PII contract as `lib/telemetry.ts`: enums, ids, numbers and booleans
 * only. Never the prompt, never a seed (a seed plus a prompt reproduces the
 * image), never a path. Property names are event-specific — `generate_status`
 * rather than `status` — because PostHog types a property once project-wide
 * (see `scripts/check-telemetry-props.mjs`).
 */

import { queuedCapture } from '@/lib/telemetry-queue'
import type { MediaTarget } from '@/services/media/types'
import { useProviderRegistryStore } from '@/stores/provider-registry-store'
import { isSelfHostedProviderName } from '@/utils/registerRemoteProvider'
import type {
  DiffusionBackend,
  DiffusionEngineId,
  DiffusionFamilyId,
  NativeDiffusionErrorCode,
  VideoEstimate,
  VideoEstimateBasis,
  VideoMemoryVerdict,
} from '@/services/diffusion/types'

export type ImageGenerateStatus = 'completed' | 'failed' | 'cancelled'

/** Where a generation ran: this machine's engine, or a provider through the core. */
export type MediaTargetProps = {
  media_target: 'local' | 'remote'
  /** The provider's catalog id; `custom` for one the user added, whose name is theirs. */
  media_provider: string | null
}

/** The target fields of `image_generate` and `video_generate`, from the request's target. */
export function mediaTargetProps(
  target: MediaTarget | undefined
): MediaTargetProps {
  if (!target) return { media_target: 'local', media_provider: null }
  const known =
    isSelfHostedProviderName(target.provider) ||
    useProviderRegistryStore
      .getState()
      .providers.some((provider) => provider.provider === target.provider)
  return {
    media_target: 'remote',
    media_provider: known ? target.provider : 'custom',
  }
}

export type ImageGenerateProps = MediaTargetProps & {
  generate_status: ImageGenerateStatus
  model_family: DiffusionFamilyId | null
  quant: string | null
  engine: DiffusionEngineId | null
  backend: DiffusionBackend | null
  width: number
  height: number
  steps: number
  batch_size: number
  runs: number
  duration_ms: number | null
  error_code: NativeDiffusionErrorCode | null
}

export function captureImageGenerate(props: ImageGenerateProps): void {
  queuedCapture('image_generate', {
    generate_status: props.generate_status,
    model_family: props.model_family,
    quant: props.quant,
    engine: props.engine,
    backend: props.backend,
    width: props.width,
    height: props.height,
    steps: props.steps,
    batch_size: props.batch_size,
    runs: props.runs,
    duration_ms: props.duration_ms,
    error_code: props.error_code,
    media_target: props.media_target,
    media_provider: props.media_provider,
  })
}

export type ImageEngineInstallStatus = 'started' | 'completed' | 'failed'

export type ImageEngineInstallProps = {
  install_status: ImageEngineInstallStatus
  /** Manifest backend id, e.g. `macos-arm64`; null when none could be picked. */
  backend: string | null
  duration_ms: number | null
  error_code: NativeDiffusionErrorCode | null
}

export function captureImageEngineInstall(
  props: ImageEngineInstallProps
): void {
  queuedCapture('image_engine_install', {
    install_status: props.install_status,
    backend: props.backend,
    duration_ms: props.duration_ms,
    error_code: props.error_code,
  })
}

export type ImageGalleryAction =
  | 'open'
  | 'save_as'
  | 'reveal'
  | 'delete'
  | 'restore_recipe'
  | 'use_as_source'
  | 'copy_prompt'

export function captureImageGalleryAction(action: ImageGalleryAction): void {
  queuedCapture('image_gallery_action', { gallery_action: action })
}

export type VideoGenerateProps = MediaTargetProps & {
  generate_status: ImageGenerateStatus
  model_family: DiffusionFamilyId | null
  quant: string | null
  engine: DiffusionEngineId | null
  backend: DiffusionBackend | null
  width: number
  height: number
  frames: number
  fps: number
  steps: number
  duration_ms: number | null
  error_code: NativeDiffusionErrorCode | null
  /** The core's memory verdict when the job started; `none` without an estimate. */
  estimate_verdict: VideoMemoryVerdict | 'none'
  /** The estimated range in seconds; null without one (and for `exceeds`, which has none). */
  estimate_low_s: number | null
  estimate_high_s: number | null
  estimate_basis: VideoEstimateBasis | null
  /** The core flagged a sharp slowdown during the job. */
  slowdown_seen: boolean
}

/** The estimate fields of `video_generate`, from the job's estimate and its last progress. */
export function videoEstimateProps(job: {
  estimate?: VideoEstimate
  progress: { slowdown?: boolean } | null
}): Pick<
  VideoGenerateProps,
  | 'estimate_verdict'
  | 'estimate_low_s'
  | 'estimate_high_s'
  | 'estimate_basis'
  | 'slowdown_seen'
> {
  const estimate = job.estimate
  return {
    estimate_verdict: estimate?.memory.verdict ?? 'none',
    estimate_low_s: estimate?.seconds?.low ?? null,
    estimate_high_s: estimate?.seconds?.high ?? null,
    estimate_basis: estimate?.basis ?? null,
    // The core keeps the flag once set, so the last progress tells.
    slowdown_seen: job.progress?.slowdown === true,
  }
}

/** One event per video job; never the prompt, the seed or a path. */
export function captureVideoGenerate(props: VideoGenerateProps): void {
  queuedCapture('video_generate', {
    generate_status: props.generate_status,
    model_family: props.model_family,
    quant: props.quant,
    engine: props.engine,
    backend: props.backend,
    width: props.width,
    height: props.height,
    frames: props.frames,
    fps: props.fps,
    steps: props.steps,
    duration_ms: props.duration_ms,
    error_code: props.error_code,
    estimate_verdict: props.estimate_verdict,
    estimate_low_s: props.estimate_low_s,
    estimate_high_s: props.estimate_high_s,
    estimate_basis: props.estimate_basis,
    slowdown_seen: props.slowdown_seen,
    media_target: props.media_target,
    media_provider: props.media_provider,
  })
}

export type VideoGalleryAction =
  | 'open'
  | 'save_as'
  | 'reveal'
  | 'delete'
  | 'restore_recipe'
  | 'copy_prompt'

export function captureVideoGalleryAction(action: VideoGalleryAction): void {
  queuedCapture('video_gallery_action', { gallery_action: action })
}
