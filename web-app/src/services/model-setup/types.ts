/**
 * What the core says about a model file, and what the app plans for a Bonsai
 * download from it: `POST /atomic/v1/models/compatibility` (atomic-chat-core
 * `src/contracts/model-compatibility.ts`), `GET /models/atomic-prism/families`,
 * the PrismML catalog and the free disk space. The core no longer sets models
 * up (0.17.0); the app downloads them. Bodies are snake_case, verbatim from
 * the core; only the fields the app reads are typed.
 */

export type CompatibilityOutcome =
  | 'compatible'
  | 'engine_required'
  | 'engine_update_required'
  | 'legacy_artifact'
  | 'inspection_required'
  | 'unsupported'

export type CompatibilityVerdict = {
  outcome: CompatibilityOutcome
  /** The provider the file must run on; `null` = any llama.cpp provider. */
  provider: string | null
  requires: string[]
  evidence: 'rules' | 'header' | 'none'
  rules_version: number
  min_prism_build?: number
  installed_prism_build?: number | null
  /** `legacy_artifact`: the file to get instead, in the same repository. */
  replacement?: string
  family?: string
  reason: string
}

export type ModelCompatibilityRequest = {
  model_id?: string
  repo?: string
  file?: string
  revision?: string
  sha256?: string
  inspect_remote?: boolean
  provider?: string
}

/** A failure as the relay hands it on: the core's own code and words. */
export type CoreCallError = {
  code: string
  message: string
  details?: string
}

/** A file of a Bonsai family the Hub may offer (`GET /models/atomic-prism/families`). */
export type PrismFamilyFile = {
  file: string
  size: number
  sha256: string
  packing?: string
  /** `prism_required`: only PrismML runs it; `any`: every llama.cpp engine does. */
  treatment: 'prism_required' | 'any'
  /** The file the family recommends. */
  default?: boolean
  summary?: string
}

/** One Bonsai model as the conf model rules name it, pinned to a revision. */
export type PrismFamily = {
  id: string
  title: string
  repo: string
  revision: string
  featured?: boolean
  files: PrismFamilyFile[]
  projectors: { file: string; size: number; sha256: string; default?: boolean }[]
}

export type PrismFamiliesResponse = {
  rules_version: number
  families: PrismFamily[]
}

/** A PrismML build: a release tag and the variant for this machine. */
export type PrismPack = { version: string; backend: string }

/**
 * `POST /backends/atomic-prism/catalog`, the fields a Bonsai plan reads:
 * the packs on disk, the hardware-fit offer (`available`), the core's pick
 * for this machine and each offered release's download sizes.
 */
export type PrismCatalog = {
  installed: PrismPack[]
  available: (PrismPack & { order?: number })[]
  recommended: string | null
  releases?: { tag: string; variants: { id: string; size?: number }[] }[]
}

/** What the Hub asks to set up: one file of a repository, under the id it registers as. */
export type PrismSetupRequest = {
  repo: string
  file: string
  revision?: string
  model_id: string
  include_projector: boolean
}

export type PrismSetupArtifact = {
  file: string
  url: string
  /** Bytes; `0` when the families did not say. */
  size: number
  sha256?: string
}

export type PrismSetupEngine = PrismPack & {
  /** The build is on disk: nothing to download, at most an activation. */
  installed: boolean
  download_size: number
}

/**
 * Why a Bonsai download cannot start. `unsupported` and `legacy_artifact`
 * carry the core's own words; the app words the other two.
 */
export type PrismSetupBlocker =
  | { code: 'unsupported'; message: string }
  | { code: 'legacy_artifact'; message: string; replacement?: string }
  | { code: 'no_engine_build' }
  | { code: 'insufficient_disk_space'; needed: number; free: number }

/** What a Bonsai download takes on this machine, built by the app from what the core reports. */
export type PrismSetupPlan = {
  model_id: string
  verdict: CompatibilityVerdict
  /** `null` when no PrismML build is involved or none fits. */
  engine: PrismSetupEngine | null
  model: PrismSetupArtifact
  projector: PrismSetupArtifact | null
  /** The file has a vision projector, whether or not this plan takes it. */
  offers_projector: boolean
  total_download_bytes: number
  free_bytes: number | null
  blockers: PrismSetupBlocker[]
}

export interface ModelSetupService {
  /** `false` where there is no core (web, mobile): the Hub downloads as before. */
  isSupported(): boolean
  checkCompatibility(
    request: ModelCompatibilityRequest
  ): Promise<CompatibilityVerdict>
  /** The Bonsai models the Hub lists under PrismML. */
  families(): Promise<PrismFamiliesResponse>
  /** The PrismML builds on disk and on offer for this machine. */
  prismCatalog(): Promise<PrismCatalog>
  /** Free bytes on the data drive; `null` when the platform cannot say. */
  diskAvailable(): Promise<number | null>
  /** Install a PrismML build under `taskId`; its bytes arrive as `download:progress`. */
  installPrismBuild(pack: PrismPack, taskId: string): Promise<void>
  /** Make an installed PrismML build the one the next load runs. */
  activatePrismBuild(pack: PrismPack): Promise<void>
  /** `handler` runs when a new core generation attaches; returns the detach. */
  onCoreReset(handler: () => void): () => void
}
