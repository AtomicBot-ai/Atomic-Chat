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
import type {
  DiffusionBackend,
  DiffusionEngineId,
  DiffusionFamilyId,
  NativeDiffusionErrorCode,
} from '@/services/diffusion/types'

export type ImageGenerateStatus = 'completed' | 'failed' | 'cancelled'

export type ImageGenerateProps = {
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
  | 'copy_prompt'

export function captureImageGalleryAction(action: ImageGalleryAction): void {
  queuedCapture('image_gallery_action', { gallery_action: action })
}
