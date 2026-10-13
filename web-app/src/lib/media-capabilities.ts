/**
 * A provider's model as the Images and Video forms see it: the catalog descriptor turned into the
 * capabilities the local form already understands, and the provider-only settings checked against
 * what the model offers (a value it does not take falls back to its default). Pure.
 */

import type {
  ImageCapabilities,
  ImageWorkflowId,
} from '@/services/diffusion/types'
import type {
  ImageModelDescriptor,
  MediaChoice,
  RemoteImageOptions,
  RemoteVideoOptions,
  VideoModelDescriptor,
} from '@/services/media/types'

const DEFAULT_EDGE = 1024

/** `'1536x1024'` → its dimensions; anything else (`auto`, a tier) → `undefined`. */
export function parseSize(
  size: string | undefined
): { width: number; height: number } | undefined {
  const match = /^(\d+)x(\d+)$/i.exec(size ?? '')
  return match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : undefined
}

/** The value if the choice offers it, else the choice's default (or its first value). */
export function pickChoice(
  choice: MediaChoice | undefined,
  value: string | undefined
): string | undefined {
  if (!choice) return undefined
  if (value !== undefined && choice.values.includes(value)) return value
  return choice.default ?? choice.values[0]
}

/** `1536x1024` → `1536 × 1024`, `png` → `PNG`; `auto` is translated, the rest is the provider's word. */
export function remoteChoiceLabel(
  value: string,
  t: (key: string) => string
): string {
  if (value === 'auto') return t('images:remote.auto')
  if (/^\d+x\d+$/i.test(value)) return value.replace(/x/i, ' × ')
  if (/^(png|jpe?g|webp)$/i.test(value)) return value.toUpperCase()
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * The capabilities a provider's image model gives the form: its workflows, its size range (a
 * provider with a list of sizes is free-form here; the list is offered by the remote controls),
 * its batch cap, and the steps/CFG it takes, which most providers do not (a range of 0).
 */
export function remoteImageCapabilities(
  model: ImageModelDescriptor
): ImageCapabilities {
  const { params } = model
  const size = params.size
  const range = size?.kind === 'range' ? size : undefined
  const enumDefault =
    size?.kind === 'enum' ? parseSize(size.default) : undefined
  const width = range?.default_width ?? enumDefault?.width ?? DEFAULT_EDGE
  const height = range?.default_height ?? enumDefault?.height ?? DEFAULT_EDGE
  const steps = params.steps
  return {
    workflows: model.workflows as ImageWorkflowId[],
    minDim: range?.min ?? 64,
    maxDim: range?.max ?? 8192,
    dimMultiple: range?.multiple ?? 1,
    supportsNegativePrompt: params.negative_prompt === true,
    supportsGuidance: params.guidance !== undefined,
    cancelGenerating: true,
    maxBatch: params.n?.max ?? 1,
    defaults: {
      steps: steps?.default ?? 0,
      cfgScale: params.cfg?.default ?? 0,
      ...(params.guidance?.default !== undefined
        ? { guidance: params.guidance.default }
        : {}),
      width,
      height,
    },
    ranges: {
      steps: steps ? [steps.min, steps.max] : [0, 0],
      dims: [range?.min ?? 64, range?.max ?? 8192],
      dimMultiple: range?.multiple ?? 1,
    },
  }
}

/** The provider-only image settings the request carries: the form's, checked against the model. */
export function effectiveImageOptions(
  model: ImageModelDescriptor,
  form: RemoteImageOptions
): RemoteImageOptions {
  const { params } = model
  const out: RemoteImageOptions = {}
  if (params.size?.kind === 'enum') {
    const size = pickChoice(
      { values: params.size.values, default: params.size.default },
      form.size
    )
    if (size) out.size = size
  }
  const pairs: Array<[keyof RemoteImageOptions, MediaChoice | undefined]> = [
    ['aspectRatio', params.aspect_ratios],
    ['resolution', params.resolutions],
    ['quality', params.quality],
    ['background', params.background],
    ['outputFormat', params.output_format],
  ]
  for (const [key, choice] of pairs) {
    const value = pickChoice(choice, form[key])
    if (value) out[key] = value
  }
  return out
}

/** The clip lengths a model offers, for the length picker: its list, or every whole second of its range. */
export function durationChoices(model: VideoModelDescriptor): number[] {
  const durations = model.params.durations
  if (!durations) return []
  if (durations.values) return [...durations.values].sort((a, b) => a - b)
  const min = Math.ceil(durations.min ?? 1)
  const max = Math.floor(durations.max ?? min)
  const out: number[] = []
  for (let s = min; s <= max && out.length < 60; s++) out.push(s)
  return out
}

/** The provider-only video settings the request carries: the form's, checked against the model. */
export function effectiveVideoOptions(
  model: VideoModelDescriptor,
  form: RemoteVideoOptions
): RemoteVideoOptions {
  const { params } = model
  const out: RemoteVideoOptions = {}
  const lengths = durationChoices(model)
  if (lengths.length > 0) {
    const wanted = form.durationSecs
    out.durationSecs =
      wanted !== undefined && lengths.includes(wanted)
        ? wanted
        : (params.durations?.default ?? lengths[0])
  }
  const resolution = pickChoice(params.resolutions, form.resolution)
  if (resolution) out.resolution = resolution
  const aspect = pickChoice(params.aspect_ratios, form.aspectRatio)
  if (aspect) out.aspectRatio = aspect
  const size = pickChoice(params.sizes, form.size)
  if (size) out.size = size
  if (params.audio && form.generateAudio !== undefined)
    out.generateAudio = form.generateAudio
  return out
}

/**
 * The nominal pixel size of a remote clip, for the pending tile: a listed size, else the
 * resolution and aspect ratio, else 16:9 at 720p.
 */
export function nominalVideoSize(options: RemoteVideoOptions): {
  width: number
  height: number
} {
  const listed = parseSize(options.size)
  if (listed) return listed
  const tier = /(\d{3,4})p/i.exec(options.resolution ?? '')
  const short = tier
    ? Number(tier[1])
    : /4k/i.test(options.resolution ?? '')
      ? 2160
      : 720
  const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(
    options.aspectRatio ?? '16:9'
  )
  const [w, h] = ratio ? [Number(ratio[1]), Number(ratio[2])] : [16, 9]
  if (w >= h) return { width: Math.round((short * w) / h), height: short }
  return { width: short, height: Math.round((short * h) / w) }
}
