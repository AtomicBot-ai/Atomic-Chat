/**
 * Microsoft Foundry Local as the core runs it (openspec change
 * `add-foundry-local`): its accelerators, the explicit step that prepares them
 * and the verdict on a variant. Vendored from `@atomic-chat/core/contracts`
 * (`foundry-local.ts`); snake_case on the wire, like `/engine-builds`.
 *
 * Nothing downloads an accelerator on its own: only `prepare`, which the
 * provider page calls when the person asks.
 */

/** The accelerators a variant may name, as conf's model list and `model.yml` spell them. */
export const FOUNDRY_LOCAL_EXECUTION_PROVIDERS = [
  'cpu',
  'cuda',
  'webgpu',
  'openvino',
  'qnn',
  'vitisai',
] as const
export type FoundryLocalExecutionProvider =
  (typeof FOUNDRY_LOCAL_EXECUTION_PROVIDERS)[number]

export const FOUNDRY_LOCAL_DEVICES = ['cpu', 'gpu', 'npu'] as const
export type FoundryLocalDevice = (typeof FOUNDRY_LOCAL_DEVICES)[number]

export interface FoundryLocalAccelerator {
  /** The library's name (`OpenVINOExecutionProvider`, `CUDAExecutionProvider`, …). */
  name: string
  /** The conf spelling; `null` for one the core runs no variant on (TensorRT-RTX). */
  execution_provider: FoundryLocalExecutionProvider | null
  /** `gpu`, `npu`, `cpu`, or `gpu/npu` for OpenVINO, which Windows ML offers without an NPU too. */
  device: string
  /** Downloaded and registered by a `prepare` on this machine. */
  prepared: boolean
  /** Why the last `prepare` did not prepare it, in the library's words when it had any. */
  reason?: string
}

/** `GET /runtimes/foundry-local/accelerators`. */
export interface FoundryLocalAccelerators {
  /** `false`: no Foundry Local build is installed; the list is empty and nothing was probed. */
  installed: boolean
  /** The build probed, `<tag>/<platform>`. */
  build: string | null
  version: string | null
  c_api_version: number | null
  /** Milliseconds since the epoch of the probe; `null` when none ran. */
  probed_at: number | null
  accelerators: FoundryLocalAccelerator[]
  /** Why the probe failed; the list is then empty. */
  error: string | null
}

/** `POST /runtimes/foundry-local/accelerators/prepare`. */
export interface FoundryLocalPrepareResult {
  accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
}

export type FoundryLocalPrepareStage = 'started' | 'downloading' | 'done' | 'failed'

/**
 * `foundry-local:accelerators`: one accelerator's step of a `prepare`.
 * `fraction` is 0…1 while a CDN download runs; Windows ML accelerators report
 * none, only `started` and `done`/`failed`.
 */
export interface FoundryLocalAcceleratorsEvent {
  accelerator: string
  stage: FoundryLocalPrepareStage
  fraction: number | null
  reason?: string
}

/** The body of `POST /models/foundry-local/check`. */
export interface FoundryLocalCheckRequest {
  execution_provider: string
  device: string
}

export type FoundryLocalCheckVerdict =
  | 'ok'
  | 'accelerator-not-prepared'
  | 'accelerator-unavailable'
  | 'platform-unsupported'
  | 'engine-not-installed'

/** Whether a variant would run here: platform, installed build, last probe, NPU — no network. */
export interface FoundryLocalCheckResult {
  verdict: FoundryLocalCheckVerdict
  /** Why, in words a card can show; `null` for `ok`. */
  reason: string | null
  /** The library name of the accelerator the variant needs; `null` for the CPU. */
  accelerator: string | null
}
