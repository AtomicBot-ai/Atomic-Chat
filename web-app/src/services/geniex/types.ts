/**
 * Qualcomm GenieX as the core runs it on a Snapdragon X laptop (openspec change
 * `add-geniex-runtime`): the devices its library found (the Hexagon NPU, the Adreno GPU), the
 * verdict on a variant before it downloads or on a model on disk, and the facts the core reads from
 * a GGUF file or an AI Hub bundle. Vendored from `@atomic-chat/core/contracts` (`geniex.ts`,
 * `model-yml.ts`; core v0.20.2); snake_case on the wire.
 *
 * Nothing is ever downloaded for a device: the NPU and GPU libraries ship inside the SDK build, so
 * every device the core lists is prepared and `prepare` only says so.
 */

/** The devices a model runs on, as conf's list, `model.yml` and the settings spell them. */
export const GENIEX_DEVICES = ['npu', 'gpu', 'cpu', 'hybrid'] as const
export type GeniexDevice = (typeof GENIEX_DEVICES)[number]

/** `llama_cpp` runs a GGUF file, `qairt` an AI Hub bundle (NPU only). */
export const GENIEX_PLUGINS = ['llama_cpp', 'qairt'] as const
export type GeniexPlugin = (typeof GENIEX_PLUGINS)[number]

/** The Snapdragon chips AI Hub bundles are compiled for: X Elite (X1E) and X2 Elite (X2E). */
export const GENIEX_CHIPS = ['x-elite', 'x2-elite'] as const
export type GeniexChip = (typeof GENIEX_CHIPS)[number]

export interface GeniexAccelerator {
  /** `npu` or `gpu`. */
  name: string
  /** The device, the same word: what a variant names. */
  device: GeniexDevice
  /** The GenieX version of the active build. */
  version: string
  /** Nothing to download: the libraries are in the build. */
  size_bytes: number
  /** Always `true`: found by the library at the build's install. */
  prepared: boolean
  reason?: string
}

/** `GET /runtimes/geniex/accelerators`, in LiteRT-LM's shape. */
export interface GeniexAccelerators {
  /** `false`: no GenieX build is installed; the list is empty. */
  installed: boolean
  /** The active build, `<version>/<platform>`. */
  build: string | null
  /** This computer's chip, whatever is installed. */
  chip: GeniexChip | null
  /** The devices the active build's library found at its install: `npu` for `HTP0`, `gpu` for `GPUOpenCL`. */
  accelerators: GeniexAccelerator[]
  error: string | null
}

/** `POST /runtimes/geniex/accelerators/prepare`: nothing to prepare; every name answers with why. */
export interface GeniexPrepareResult {
  accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
}

/** What `geniex-host inspect` reads from a GGUF file's header, and the `mmproj` beside it. */
export interface GeniexGgufMetadata {
  kind: 'gguf'
  architecture: string | null
  max_context_tokens: number | null
  /** `Q4_0`, `Q4_K_M`, …; `null` when unknown. */
  quantization: string | null
  chat_template: boolean
  /** An `mmproj*.gguf` lies beside the file. */
  vision: boolean
}

/**
 * What `geniex-host inspect` reads from an AI Hub bundle folder: the context from `genie_config.json`,
 * the precision from `metadata.json`, the chip from the Hexagon generation in
 * `htp_backend_ext_config.json`. No bundle names a minimal GenieX, so the installer passes conf's.
 */
export interface GeniexBundleMetadata {
  kind: 'qairt'
  chip: GeniexChip | null
  max_context_tokens: number | null
  precision: string | null
  min_runtime_version: string | null
}

export type GeniexModelMetadata = GeniexGgufMetadata | GeniexBundleMetadata

/**
 * The body of `POST /models/geniex/check`: a variant before it downloads (`plugin`, `device`, a
 * bundle's `chip`, `min_runtime_version` when conf knows it), a downloaded file or bundle folder by
 * `path` inside `<data>/geniex/models` with its `plugin` and `device` — and, for a bundle, the
 * `chip` conf named, which stands in when the bundle's own description does not say — or an
 * installed model by `model_id`.
 */
export interface GeniexCheckRequest {
  plugin?: string
  device?: string
  chip?: string
  min_runtime_version?: string
  path?: string
  model_id?: string
}

export type GeniexCheckVerdict =
  | 'ok'
  | 'engine-not-installed'
  | 'platform-unsupported'
  | 'accelerator-unavailable'
  | 'requires-newer-engine'

export interface GeniexCheckResult {
  verdict: GeniexCheckVerdict
  /** Why, in words a card can show; `null` for `ok`. */
  reason: string | null
  /** The model's facts, for a model on disk: what the installer writes into `model.yml`. */
  metadata?: GeniexModelMetadata
}

/**
 * Where a Model Hub entry of GenieX comes from; `installed` is a model found on disk in
 * "Downloaded", whose card offers only New chat and delete.
 */
export type GeniexOrigin = 'curated' | 'huggingface' | 'installed'

/** A file of a Hugging Face repository: its path there, size and sha256 (conf's, or the LFS metadata). */
export interface GeniexHubFile {
  path: string
  size: number
  sha256: string
}

/** The GGUF side of a Hub entry (`kind: gguf`): one file, downloaded once, run on a chosen device. */
export interface GeniexHubGguf {
  /** `<org>/<name>` on Hugging Face. */
  repo: string
  /** The commit every file is downloaded from. */
  revision: string
  /** The repository asks for its terms to be accepted: a download needs the person's HF token. */
  gated: boolean
  file: GeniexHubFile
  /** The multimodal projector beside the file; present for a model with vision. */
  mmproj?: GeniexHubFile
  /** The devices the model is offered on, in conf's order. */
  devices: GeniexDevice[]
  /** `win-arm64`. */
  platforms: string[]
}

/** One AI Hub bundle of a Hub entry (`kind: qairt`): compiled for one chip, run on the NPU. */
export interface GeniexHubVariant {
  /** Names the download task and the folder `<data>/geniex/models/<id>`. */
  id: string
  chip: GeniexChip
  bundle: { url: string; size: number; sha256: string }
  /** As AI Hub names it (`w4a16`). */
  precision: string
  /** Known before download only when conf names it. */
  min_runtime_version?: string
}

/** A GenieX entry as the Hub card and the installer use it, whichever list it came from. */
export interface GeniexHubModel {
  origin: GeniexOrigin
  /** `gguf` or `qairt`; unknown for a model found on disk. */
  kind?: 'gguf' | 'qairt'
  /** conf's model id, the slug of a Hugging Face repository, or the folder name of an installed model. */
  model_id: string
  /** The name shown on the row and the card. */
  name: string
  summary: string
  license: string | null
  /** Known for a curated model; a Hugging Face model learns them from the core's check of the file. */
  context_length?: number
  tools?: boolean
  reasoning?: boolean
  vision?: boolean
  /** `kind: gguf`. */
  gguf?: GeniexHubGguf
  /** `kind: qairt`: every chip's bundle; the card shows the one for this computer's chip. */
  variants?: GeniexHubVariant[]
}
