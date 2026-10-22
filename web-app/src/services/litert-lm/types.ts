/**
 * Google LiteRT-LM as the core runs it (openspec change
 * `add-litert-lm-runtime`): the one accelerator an Intel NPU variant needs
 * (`openvino`), the explicit step that prepares it and the verdict on a
 * variant or a downloaded file. Vendored from `@atomic-chat/core/contracts`
 * (`litert-lm.ts`, `model-yml.ts`; core 0.19.0); snake_case on the wire.
 *
 * Nothing downloads the accelerator on its own: only `prepare`, which the
 * provider page calls once after an install or when the person asks.
 */

/** The backends a variant runs on, as conf's list and `model.yml` spell them. */
export const LITERT_LM_BACKENDS = ['cpu', 'gpu', 'npu'] as const
export type LiteRtLmBackend = (typeof LITERT_LM_BACKENDS)[number]

/** The Intel NPU generations files are compiled for: Lunar Lake and Panther Lake. */
export const LITERT_LM_NPUS = ['intel-lnl', 'intel-ptl'] as const
export type LiteRtLmNpu = (typeof LITERT_LM_NPUS)[number]

export interface LiteRtLmAccelerator {
  /** `openvino`. */
  name: string
  /** `npu`: the only device it serves. */
  device: string
  /** The OpenVINO version the active release pins. */
  version: string
  /** What a prepare downloads. */
  size_bytes: number
  /** Downloaded, checked and unpacked on this machine. */
  prepared: boolean
  /** Why the last prepare failed. */
  reason?: string
}

/** `GET /runtimes/litert-lm/accelerators`. */
export interface LiteRtLmAccelerators {
  /** `false`: no LiteRT-LM build is installed; the list is empty. */
  installed: boolean
  /** The active build, `<version>/<platform>`. */
  build: string | null
  /** This machine's Intel NPU generation; `null` without one (the list is empty). */
  npu: LiteRtLmNpu | null
  accelerators: LiteRtLmAccelerator[]
  /** Why the list could not be made (no manifest for the active release, …). */
  error: string | null
}

/** `POST /runtimes/litert-lm/accelerators/prepare`. */
export interface LiteRtLmPrepareResult {
  accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
}

export type LiteRtLmPrepareStage = 'started' | 'downloading' | 'done' | 'failed'

/** `litert-lm:accelerators`: one step of a prepare; `fraction` 0…1 while it downloads. */
export interface LiteRtLmAcceleratorsEvent {
  accelerator: string
  stage: LiteRtLmPrepareStage
  fraction: number | null
  reason?: string
}

/** What `litert-host inspect` reads from a `.litertlm` file, returned by a check of a file on disk. */
export interface LiteRtLmFileMetadata {
  model_type: 'llm' | 'embedding' | 'unknown'
  /** `null` when the file does not declare one. */
  max_context_tokens: number | null
  dynamic_context: boolean
  /** As the file declares it; Gemma 4 files say `false` and call tools anyway. */
  function_calling: boolean
  thinking: boolean
  modalities: Array<'text' | 'vision' | 'audio' | 'video'>
  /** Backends of the text modality, the default first. */
  backends: LiteRtLmBackend[]
  vision_backends: LiteRtLmBackend[]
  npu: { brand: string; soc: string | null } | null
  speculative_decoding: boolean
  min_runtime_version: string | null
}

/**
 * The body of `POST /models/litert-lm/check`: a variant before it downloads
 * (`backend`, `npu`, `min_runtime_version` from conf), a downloaded file by
 * `path` inside `<data>/litert-lm/models` with the variant's `backend`/`npu`,
 * or an installed model by `model_id`.
 */
export interface LiteRtLmCheckRequest {
  backend?: string
  npu?: string
  min_runtime_version?: string
  path?: string
  model_id?: string
}

export type LiteRtLmCheckVerdict =
  | 'ok'
  | 'engine-not-installed'
  | 'platform-unsupported'
  | 'accelerator-unavailable'
  | 'accelerator-not-prepared'
  | 'requires-newer-engine'

export interface LiteRtLmCheckResult {
  verdict: LiteRtLmCheckVerdict
  /** Why, in words a card can show; `null` for `ok`. */
  reason: string | null
  /** The file's facts, for a file on disk: what the installer writes into `model.yml`. */
  metadata?: LiteRtLmFileMetadata
}

/**
 * Where a Model Hub entry of LiteRT-LM comes from; `installed` is a variant found on disk in
 * "Downloaded", whose card offers only New chat and delete.
 */
export type LiteRtLmOrigin = 'curated' | 'huggingface' | 'installed'

/** A variant as the Hub card and the installer use it, whichever list it came from. */
export interface LiteRtLmHubVariant {
  /** Names the download task and the folder `<data>/litert-lm/models/<id>`. */
  id: string
  backend: LiteRtLmBackend
  npu?: LiteRtLmNpu
  /** `macos-arm64`, `linux-x64`, `linux-arm64`, `win-x64`. */
  platforms: string[]
  /** Known before download only for a curated variant that names it. */
  min_runtime_version?: string
  /** Its path in the repository, size and sha256 (conf's, or the repository's LFS metadata). */
  file: { path: string; size: number; sha256: string }
}

/** The `litert_lm` part of a Hub entry (`CatalogModel.litert_lm`). */
export interface LiteRtLmHubModel {
  origin: LiteRtLmOrigin
  /** conf's model id, or the repository for a Hugging Face model. */
  model_id: string
  /** The name shown on the row and the card. */
  name: string
  summary: string
  license: string | null
  repo: string
  /** The commit every file is downloaded from. */
  revision: string
  /** The repository asks for its terms to be accepted: a download needs the person's HF token. */
  gated: boolean
  /**
   * Known for a curated model; a Hugging Face model learns them from the core's check of the
   * downloaded file.
   */
  context_length?: number
  tools?: boolean
  reasoning?: boolean
  vision?: boolean
  variants: LiteRtLmHubVariant[]
}
