/**
 * Validate a video request against the loaded model's capabilities — before
 * the plugin is asked, so a bad request costs no round-trip and gets a
 * specific message. Mirrors the core's `validateVideoRequest`, which checks
 * again natively (the OpenAI facade reaches it without this layer).
 */

import type {
  ImageSource,
  NativeDiffusionErrorCode,
  VideoCapabilities,
  VideoGenerateRequest,
} from '@/services/diffusion/types'

export type VideoRequestValidation =
  | { ok: true }
  | { ok: false; code: NativeDiffusionErrorCode; message: string }

const reject = (
  code: NativeDiffusionErrorCode,
  message: string
): VideoRequestValidation => ({ ok: false, code, message })

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const hasSource = (source: ImageSource | undefined): boolean =>
  !!source &&
  (('path' in source && source.path.trim().length > 0) ||
    ('base64' in source && source.base64.trim().length > 0))

/** Whether `frames` sits on the family's lattice inside its range. */
export function isValidFrameCount(
  frames: number,
  lattice: VideoCapabilities['frames']
): boolean {
  if (!isInt(frames) || frames < lattice.min || frames > lattice.max) return false
  return lattice.step <= 0 || (frames - lattice.offset) % lattice.step === 0
}

export function validateVideoRequest(
  req: VideoGenerateRequest,
  caps: VideoCapabilities
): VideoRequestValidation {
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) {
    return reject('INVALID_REQUEST', 'Enter a prompt to generate a video.')
  }

  const workflow = req.workflow ?? 'create'
  if (workflow !== 'create' || !caps.workflows.includes(workflow)) {
    return reject('UNSUPPORTED_WORKFLOW', 'Image-to-video is not available yet.')
  }
  if (hasSource(req.initImage) || hasSource(req.endImage)) {
    return reject('UNSUPPORTED_WORKFLOW', 'Image-to-video is not available yet.')
  }

  for (const [name, value] of [
    ['Width', req.width],
    ['Height', req.height],
  ] as const) {
    if (!isInt(value)) {
      return reject('INVALID_DIMENSIONS', `${name} must be a whole number.`)
    }
    if (value < caps.minDim || value > caps.maxDim) {
      return reject(
        'INVALID_DIMENSIONS',
        `${name} must be between ${caps.minDim} and ${caps.maxDim} pixels.`
      )
    }
    if (caps.dimMultiple > 1 && value % caps.dimMultiple !== 0) {
      return reject(
        'INVALID_DIMENSIONS',
        `${name} must be a multiple of ${caps.dimMultiple}.`
      )
    }
  }

  const [minSteps, maxSteps] = caps.ranges.steps
  if (!isInt(req.steps) || req.steps < minSteps || req.steps > maxSteps) {
    return reject(
      'INVALID_REQUEST',
      `Steps must be between ${minSteps} and ${maxSteps}.`
    )
  }

  if (!isFiniteNumber(req.cfgScale) || req.cfgScale < 0) {
    return reject('INVALID_REQUEST', 'CFG scale must be zero or more.')
  }
  if (
    req.guidance !== undefined &&
    (!isFiniteNumber(req.guidance) || req.guidance < 0)
  ) {
    return reject('INVALID_REQUEST', 'Guidance must be zero or more.')
  }

  if (req.seed !== undefined && !isInt(req.seed)) {
    return reject('INVALID_REQUEST', 'Seed must be a whole number.')
  }

  if (req.fps !== undefined && req.fps !== caps.fps) {
    return reject('INVALID_REQUEST', `This model generates at ${caps.fps} fps.`)
  }

  if (req.frames !== undefined && !isValidFrameCount(req.frames, caps.frames)) {
    const { step, offset, min, max } = caps.frames
    return reject(
      'INVALID_REQUEST',
      `Frames must be ${step}k+${offset} between ${min} and ${max}.`
    )
  }

  if (
    !caps.supportsNegativePrompt &&
    typeof req.negativePrompt === 'string' &&
    req.negativePrompt.trim().length > 0
  ) {
    return reject(
      'INVALID_REQUEST',
      'This model does not take a negative prompt.'
    )
  }

  if (
    req.flowShift !== undefined &&
    (!isFiniteNumber(req.flowShift) || req.flowShift <= 0)
  ) {
    return reject('INVALID_REQUEST', 'Flow shift must be greater than zero.')
  }

  return { ok: true }
}
