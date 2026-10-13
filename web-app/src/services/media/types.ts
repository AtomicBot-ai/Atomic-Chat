/**
 * Remote media: the image and video models cloud providers and self-hosted servers offer through the
 * core. Mirrors `atomic-chat-core` `src/contracts/media.ts`: the catalog shapes are conf's
 * `providers/media.json` as the core serves it (snake_case, like the cloud provider routes); what a
 * generation request carries for a remote model sits in the camelCase diffusion requests (`target`,
 * `remote`, `services/diffusion/types.ts`).
 */

export type MediaDialect =
  | 'openai-images'
  | 'xai-images'
  | 'openrouter-images'
  | 'gemini-image'
  | 'minimax-image'
  | 'dashscope-image'
  | 'hf-images'
  | 'nvidia-genai'
  | 'mistral-agent-image'
  | 'a1111'
  | 'openai-videos'
  | 'openrouter-videos'
  | 'xai-videos'
  | 'gemini-veo'
  | 'minimax-video'
  | 'minimax-video-v2'
  | 'dashscope-video'
  | 'aimlapi-videos'
  | 'hf-videos'

export type MediaKind = 'image' | 'video'

export type RemoteImageWorkflow = 'create' | 'transform' | 'inpaint' | 'reference' | 'edit'
export type RemoteVideoWorkflow = 'create' | 'image-to-video'

export type MediaChoice = { values: string[]; default?: string }

export type MediaNumberRange = { min: number; max: number; default?: number; step?: number }

export type MediaSizeParam =
  | { kind: 'enum'; values: string[]; default?: string }
  | {
      kind: 'range'
      min: number
      max: number
      multiple: number
      default_width?: number
      default_height?: number
    }

/** What the generation form offers for an image model; a missing key is a hidden control. */
export type MediaImageParams = {
  size?: MediaSizeParam
  aspect_ratios?: MediaChoice
  resolutions?: MediaChoice
  n?: { max: number }
  seed?: boolean
  negative_prompt?: boolean
  quality?: MediaChoice
  background?: MediaChoice
  output_format?: MediaChoice
  steps?: MediaNumberRange
  cfg?: MediaNumberRange
  guidance?: MediaNumberRange
  strength?: MediaNumberRange
  sampler?: boolean
  max_input_images?: number
}

export type MediaDurations = { values?: number[]; min?: number; max?: number; default?: number }

export type MediaVideoParams = {
  durations?: MediaDurations
  resolutions?: MediaChoice
  aspect_ratios?: MediaChoice
  sizes?: MediaChoice
  audio?: boolean
  seed?: boolean
  negative_prompt?: boolean
  last_frame?: boolean
}

type MediaModelCommon = {
  id: string
  name: string
  description?: string
  api: MediaDialect
  default?: boolean
  options?: Record<string, string | number | boolean>
  source: 'catalog' | 'live'
}

export type ImageModelDescriptor = MediaModelCommon & {
  kind: 'image'
  workflows: RemoteImageWorkflow[]
  params: MediaImageParams
  samplers?: string[]
}

export type VideoModelDescriptor = MediaModelCommon & {
  kind: 'video'
  workflows: RemoteVideoWorkflow[]
  params: MediaVideoParams
}

export type MediaModelDescriptor = ImageModelDescriptor | VideoModelDescriptor

export type MediaProviderSection = {
  image?: { api: MediaDialect; models: ImageModelDescriptor[] }
  video?: { api: MediaDialect; models: VideoModelDescriptor[] }
}

/** `GET /atomic/v1/media/catalog`. */
export type MediaCatalogView = {
  catalog_version: number
  origin: 'live' | 'cache' | 'baseline'
  dialects: Partial<
    Record<MediaDialect, { kind: MediaKind; workflows: string[]; params: MediaImageParams | MediaVideoParams }>
  >
  providers: Record<string, MediaProviderSection>
}

/** `GET /atomic/v1/media/providers/:provider/models?kind=`. */
export type MediaProviderModels = {
  provider: string
  kind: MediaKind
  api: MediaDialect | null
  models: MediaModelDescriptor[]
  live: boolean
  error?: { code: string; message: string }
}

/** One enabled media model in a provider registration. */
export type CloudProviderMediaModel = { id: string; kind: MediaKind }

/** The media part of a provider registration (`PUT /cloud/providers/:id`). */
export type CloudProviderMedia = {
  image_api?: MediaDialect | null
  video_api?: MediaDialect | null
  models: CloudProviderMediaModel[]
}

/** Which provider and model a generation request is for. */
export type MediaTarget = { provider: string; model: string }

export type RemoteImageOptions = {
  size?: string
  aspectRatio?: string
  resolution?: string
  quality?: string
  background?: string
  outputFormat?: string
}

export type RemoteVideoOptions = {
  durationSecs?: number
  resolution?: string
  aspectRatio?: string
  size?: string
  generateAudio?: boolean
}

/** The adapters a custom (self-hosted) server can be given, by kind. */
export const CUSTOM_IMAGE_APIS: readonly MediaDialect[] = ['openai-images', 'a1111']
export const CUSTOM_VIDEO_APIS: readonly MediaDialect[] = ['openai-videos']

export interface MediaService {
  /** Whether this platform has a core that serves remote media. */
  isSupported(): boolean
  /** The catalog; `null` when the core has no remote media (an older core). */
  catalog(): Promise<MediaCatalogView | null>
  /** A provider's models of one kind, its live listing merged in. */
  providerModels(provider: string, kind: MediaKind): Promise<MediaProviderModels>
}
