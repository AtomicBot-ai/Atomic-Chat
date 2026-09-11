/**
 * Validate a generation request against the loaded model's capabilities —
 * before the GPU arbiter evicts anything and before the plugin is asked.
 *
 * Pure. The plugin validates again natively (the OpenAI facade reaches it
 * without this layer), but a request rejected here costs the user nothing:
 * no chat model unloaded, no server round-trip, and a specific message.
 */

import type {
  ImageCapabilities,
  ImageGenerateRequest,
  NativeDiffusionErrorCode,
} from '@/services/diffusion/types'

export type ImageRequestValidation =
  | { ok: true }
  | { ok: false; code: NativeDiffusionErrorCode; message: string }

const reject = (
  code: NativeDiffusionErrorCode,
  message: string
): ImageRequestValidation => ({ ok: false, code, message })

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export function validateImageRequest(
  req: ImageGenerateRequest,
  caps: ImageCapabilities
): ImageRequestValidation {
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) {
    return reject('INVALID_REQUEST', 'Enter a prompt to generate an image.')
  }

  const workflow = req.workflow ?? 'create'
  if (!caps.workflows.includes(workflow)) {
    return reject(
      'UNSUPPORTED_WORKFLOW',
      `This model does not support the "${workflow}" workflow.`
    )
  }
  if (workflow === 'transform') {
    if (!req.initImagePath) {
      return reject('INVALID_REQUEST', 'Choose a source image to transform.')
    }
    if (
      req.strength !== undefined &&
      (!isFiniteNumber(req.strength) || req.strength < 0 || req.strength > 1)
    ) {
      return reject('INVALID_REQUEST', 'Strength must be between 0 and 1.')
    }
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

  if (!isInt(req.batchSize) || req.batchSize < 1 || req.batchSize > caps.maxBatch) {
    return reject(
      'INVALID_REQUEST',
      caps.maxBatch > 1
        ? `Batch size must be between 1 and ${caps.maxBatch}.`
        : 'This model generates one image per job.'
    )
  }

  if (req.seed !== undefined && !isInt(req.seed)) {
    return reject('INVALID_REQUEST', 'Seed must be a whole number.')
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
