/**
 * The core's engine builds: stable-diffusion.cpp (`sd-server`) and MLX
 * (`mlx-server`), installed, checked and removed by the core from conf's
 * manifests. Vendored from `@atomic-chat/core/contracts` (`engine-builds.ts`,
 * core 0.12.0); snake_case on the wire, like `/backends`.
 *
 * The core advises and the app decides: `catalog` and `updates` only read,
 * `install` acts when the user asked for it.
 */

export type EngineBuildId = 'sd-cpp' | 'mlx'

/**
 * `downloaded` — installed by the core under its data folder, removable;
 * `bundled` — the `mlx-server` in the installer, read-only.
 */
export type EngineBuildOrigin = 'downloaded' | 'bundled'

export interface EngineBuildRef {
  tag: string
  backend_id: string
  origin: EngineBuildOrigin
}

export interface InstalledEngineBuild extends EngineBuildRef {
  installed_at_ms: number | null
  /** MLX: the release date builds are ordered by; `null` when unknown. */
  published_at?: string | null
  removable: boolean
  /** A loaded session runs from this build right now. */
  in_use: boolean
  /** The build the next model load uses. */
  active: boolean
}

export interface EngineBuildManifestInfo {
  tag: string
  published_at?: string
  source: 'remote' | 'cache'
  fetched_at: number
  error: string | null
}

export interface EngineBuildCatalog {
  engine: EngineBuildId
  /** `null` with `manifest_error` when there is neither a network answer nor a cached copy. */
  manifest: EngineBuildManifestInfo | null
  manifest_error: string | null
  /** The build this host would install; `null` with `host_reason` when none fits. */
  host_backend_id: string | null
  host_reason: string | null
  installed: InstalledEngineBuild[]
  active: InstalledEngineBuild | null
}

/** The core's `ProxyConfig`. */
export interface EngineBuildProxy {
  url: string
  username?: string
  password?: string
  no_proxy?: string[]
  ignore_ssl?: boolean
}

export interface EngineBuildCatalogRequest {
  /** Re-read the manifest from the network. */
  force?: boolean
  proxy?: EngineBuildProxy | null
}

export type EngineBuildUpdateCheckRequest = EngineBuildCatalogRequest

export interface EngineBuildTarget {
  tag: string
  backend_id: string
  published_at?: string
  /** Every archive the install downloads (the CUDA runtime included). */
  download_bytes: number
}

export interface EngineBuildUpdateCheck {
  /** `true` only for a build strictly newer than the active one. */
  update_needed: boolean
  current: EngineBuildRef | null
  target: EngineBuildTarget | null
}

export interface EngineBuildInstallRequest {
  /** The download task progress and cancellation run under. */
  task_id: string
  /** Reinstall the same build; never one older than the active build. */
  force?: boolean
  proxy?: EngineBuildProxy | null
}

export interface EngineBuildInstallResult {
  /** `false` when nothing was downloaded; `reason` says why. */
  installed: boolean
  reason?: 'already-installed' | 'active-is-newer'
  build: EngineBuildRef
  retired: EngineBuildRef[]
  kept_in_use: EngineBuildRef[]
  /** sd.cpp: builds higher on the host's ladder that failed their probe on the way down. */
  failed_backend_ids?: string[]
}

export interface EngineBuildRemoveResult {
  removed: boolean
}

export interface EngineBuildChangedEvent {
  engine: EngineBuildId
  reason: 'install' | 'uninstall' | 'startup-cleanup'
}
