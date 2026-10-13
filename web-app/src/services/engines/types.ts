/**
 * The core's one layer over every engine it installs: llama.cpp packs, the
 * sd.cpp and MLX builds and the managed engines' environments. The same four
 * commands for each: what is installed and what is newer, update, make a build
 * active, remove a build. Vendored from `@atomic-chat/core/contracts`
 * (`engines.ts`, openspec change `unify-engine-lifecycle`); snake_case on the
 * wire, like `/backends` and `/engine-builds`.
 *
 * The core still never installs on its own: the versions answer only reads,
 * and an update runs when the app calls it.
 */

import type { EngineBuildProxy } from '@/services/engine-builds/types'

/** Every engine the layer answers for, in the order the desktop lists them. */
export const ENGINE_IDS = [
  'llamacpp-upstream',
  'llamacpp',
  'atomic-prism',
  'sd-cpp',
  'mlx',
  'tensorrt-llm',
  'vllm',
] as const
export type EngineId = (typeof ENGINE_IDS)[number]

/** Which system underneath installs the engine. */
export type EngineKind = 'llamacpp' | 'engine-build' | 'managed'

/** The kind of every engine: what decides its update body, who picks its active build, how it applies. */
export const ENGINE_KINDS: Readonly<Record<EngineId, EngineKind>> = {
  'llamacpp-upstream': 'llamacpp',
  'llamacpp': 'llamacpp',
  'atomic-prism': 'llamacpp',
  'sd-cpp': 'engine-build',
  'mlx': 'engine-build',
  'tensorrt-llm': 'managed',
  'vllm': 'managed',
}

/**
 * Who picks the build the next load runs: `client` — any installed build can
 * be made active (llama.cpp, `version_backend`); `core` — the core's own rule
 * (sd.cpp and MLX: the newest; a managed engine: its one installation).
 */
export type EngineActiveChoice = 'client' | 'core'

/**
 * `downloaded` — the core put it there; `bundled` — it came with the desktop
 * installer and is never removed; `managed` — a managed engine's installation.
 */
export type EngineOrigin = 'downloaded' | 'bundled' | 'managed'

/** A build both active and in use reports `active`. */
export type EngineNotRemovableReason = 'active' | 'bundled' | 'in-use'

/**
 * What names a build in every command. `version` is the llama.cpp tag, the
 * sd.cpp/MLX tag or the managed `descriptor_id`; `variant` is the build for
 * the hardware (`win-cuda12-x64`), for a managed engine the image platform.
 */
export interface EngineBuildKey {
  version: string
  variant: string
}

export interface EngineBuild extends EngineBuildKey {
  origin: EngineOrigin
  active: boolean
  /** A session, the decision model or the embedding model runs from it right now. */
  in_use: boolean
  removable: boolean
  /** Present exactly when `removable` is `false`. */
  not_removable_reason?: EngineNotRemovableReason
}

/** A build the engine's source offers. */
export interface EngineAvailableBuild extends EngineBuildKey {
  /** Every archive or image layer the install would download, when the source says. */
  download_bytes?: number
  published_at?: string
}

export type EngineUpdateApply = 'swap' | 'reinstall'

/** Why a newer build exists but is not offered; `needed` is then `false`. */
export type EngineUpdateBlockedReason =
  | 'family-change'
  | 'unstable'
  | 'requires-newer-app'
  | 'source-unavailable'

export interface EngineUpdateOffer {
  /** `true` only for a `target` strictly newer than the active build; never without an active build. */
  needed: boolean
  target: EngineAvailableBuild | null
  /** `swap` — installed beside, the engine's sessions unloaded; `reinstall` — removed and set up again. */
  apply: EngineUpdateApply
  blocked_reason?: EngineUpdateBlockedReason
}

/** `remote` — fetched this time; `cache` — what was accepted before; `null` — neither. */
export type EngineVersionsSource = 'remote' | 'cache' | null

/** The core's error envelope, as the relay passes it on. */
export interface EngineErrorBody {
  code: string
  message: string
  details?: string
}

/** One engine of this host. */
export interface EngineVersions {
  engine: EngineId
  kind: EngineKind
  active_choice: EngineActiveChoice
  builds: EngineBuild[]
  /** The build the next model load uses, or `null`. */
  active: EngineBuildKey | null
  /** The newest build for this host by the engine's source, or `null`. */
  latest: EngineAvailableBuild | null
  update: EngineUpdateOffer
  source: EngineVersionsSource
  /** Why the source was not read from the network this time (with `cache` or `null`); `null` otherwise. */
  source_error: string | null
  /** Set when this engine's answer could not be built; the other engines are answered as usual. */
  error: EngineErrorBody | null
}

// POST /engines/versions

export interface EngineVersionsRequest {
  /** Re-read every engine's source from the network. */
  force?: boolean
  proxy?: EngineBuildProxy | null
  /** The client's version, for `minimum_app_version` and the TurboQuant `min_app_version` gate. */
  app_version?: string | null
}

export interface EngineVersionsResponse {
  /** One entry per engine registered on this host; an engine this platform lacks is absent. */
  engines: EngineVersions[]
}

// POST /engines/:engine/update

/** llama.cpp, sd.cpp and MLX: answers once applied, which can take as long as the download. */
export interface EngineSwapUpdateRequest {
  /** The download task progress and cancellation run under (`POST /downloads/:task_id/cancel`). */
  task_id: string
  /**
   * llama.cpp only: the build to move to. Without `version` — the newest of
   * that `variant` in the catalog. With a target the family check does not
   * apply: the client chose. sd.cpp and MLX refuse it.
   */
  target?: { version?: string; variant: string }
  force?: boolean
  proxy?: EngineBuildProxy | null
  app_version?: string | null
}

/** A managed engine: answers `202` with the removal that starts the reinstall. */
export interface EngineReinstallRequest {
  /** Makes a retried call the same operation; the setup that follows runs under `<request_id>:setup`. */
  request_id: string
  app_version?: string | null
}

export type EngineUpdateRequest =
  | EngineSwapUpdateRequest
  | EngineReinstallRequest

export type EngineUpdateNotAppliedReason = 'already-active' | 'no-update'

export interface EngineUpdateResult {
  /** `false` when nothing changed; `reason` says why. */
  updated: boolean
  reason?: EngineUpdateNotAppliedReason
  active: EngineBuildKey | null
  /** Builds removed after the new one became active. */
  retired: EngineBuildKey[]
  /** Builds left on disk because something still runs from them. */
  kept_in_use: EngineBuildKey[]
}

/** `202`: a managed engine's reinstall or removal began; follow it on `environment:operation`. */
export interface EngineOperationStarted {
  operation_id: string
}

// DELETE /engines/:engine/builds/:version/:variant

/** `removed: false` for a build that was not there. A managed engine answers `EngineOperationStarted`. */
export interface EngineBuildDeleteResult {
  removed: boolean
}

// POST /engines/:engine/builds/:version/:variant/activate

export interface EngineActivateResult {
  activated: boolean
  reason?: 'already-active'
  active: EngineBuildKey
}

// The event, relayed as `atomic-core://engine:changed`

export type EngineChangedReason =
  | 'update'
  | 'activate'
  | 'install'
  | 'uninstall'
  | 'startup-cleanup'
  | 'reinstall'

/** The set or the active build of an engine changed, by any route: re-read the versions. */
export interface EngineChangedEvent {
  engine: EngineId
  reason: EngineChangedReason
}
