/**
 * @file The PrismML llama.cpp engine: a third local llama.cpp provider, `atomic-prism`, that runs
 * Bonsai models whose GGUF files use tensor types only the PrismML fork
 * (https://github.com/PrismML-Eng/llama.cpp) implements.
 *
 * atomic-chat-core owns everything behind it — engine packs, hardware, the release catalog, the
 * recommendation, installs, update checks, sessions and loading. This extension is the app's view
 * of that provider: its settings, its model list (the Bonsai models the core set up in the shared
 * `llamacpp/models` tree), its backend dropdown and the engine-update offer.
 * @module atomic-prism-extension/src/index
 */

import {
  AIEngine,
  getJanDataFolderPath,
  fs,
  joinPath,
  modelInfo,
  SessionInfo,
  UnloadResult,
  chatCompletion,
  chatCompletionChunk,
  ImportOptions,
  chatCompletionRequest,
  events,
  AppEvent,
  DownloadEvent,
  chatCompletionRequestMessage,
  detectReasoningControls,
  ReasoningControls,
  ModelEvent,
  type ModelLoadOptions,
} from '@janhq/core'

import { error, info, warn } from '@tauri-apps/plugin-log'
import { listen, emit as tauriEmit } from '@tauri-apps/api/event'
import { invoke, Channel } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { basename } from '@tauri-apps/api/path'
import {
  loadCatalog,
  isBackendInstalled,
  getBackendDir,
  getLocalInstalledBackends,
  cleanupIncompleteBackends,
  friendlyBackendLabel,
  mergeBackendOptions,
  parsePrismArchiveName,
  parseVersionBackendSetting,
  prismTagBuild,
  type InstalledBackendPack,
} from './backend'
import {
  getProxyConfig,
  isConcreteVersionBackend,
  ggufShardSetPaths,
  isDownloadableUrl,
  classifyProjector,
} from './util'
import * as coreRuntime from './adapter/coreRuntime'
import { createCoreSettingsSync } from '../../shared/atomicCoreSettingsSync'
import type { PersistedSetting } from '../../shared/atomicCoreSettingsSync'
import { LoadCancelTracker, toLoadError } from '../../shared/loadCancel'
import {
  buildEngineUpdateOffer,
  clearEngineUpdateOffer,
  publishEngineUpdateOffer,
  type EngineUpdateDetails,
} from './engineUpdateOffer'
import {
  readGgufMetadata,
  isModelSupported,
  LlamacppConfig,
  DownloadItem,
  ModelConfig,
  DeviceList,
} from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
import type { RuntimeDeviceInfo } from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/types'

// Error message constant - matches web-app/src/utils/error.ts
const OUT_OF_CONTEXT_SIZE = 'the request exceeds the available context size.'

/// This provider's settings: llama.cpp's, without the speculative and multi-GPU
/// keys the PrismML schema does not carry, plus its own candidate-build gate.
type PrismConfig = Omit<
  LlamacppConfig,
  | 'split_mode'
  | 'main_gpu'
  | 'mtp'
  | 'mtp_draft_path'
  | 'dflash'
  | 'dflash_spec_supported'
  | 'dflash_draft_path'
  | 'dflash_n_max'
> & { allow_candidate_builds: boolean }

/// Payload emitted by the Rust proxy when it detects a context-limit error
/// that we (the TS side) should recover from by reloading the backend with
/// a larger ctx window.
interface AutoIncreaseCtxRequest {
  request_id: string
  backend: 'llamacpp' | 'llamacpp-upstream' | 'atomic-prism' | 'mlx'
  model_id: string
  trigger: 'error' | 'finish_length' | 'compute_error_recovery'
}

/// ATO-197: trigger value the Rust proxy sends when a fatal Metal/compute
/// failure (e.g. a GPU OOM during prompt processing) poisons the ggml backend.
/// Unlike `error` / `finish_length` (which grow the context window), this asks
/// us to reload the model with the SAME ctx to recreate the dead backend.
const COMPUTE_ERROR_RECOVERY_TRIGGER = 'compute_error_recovery'

/// Tauri channel constants used by the Rust proxy (`proxy.rs`) to coordinate
/// a context-window grow with the owning backend extension.
const AUTO_INCREASE_CTX_EVENT = 'local_backend://auto_increase_ctx'
const AUTO_INCREASE_CTX_DONE_PREFIX = 'local_backend://auto_increase_ctx_done/'
/// Broadcast channel that mirrors `ModelEvent.OnAutoIncreasedCtxLen` but
/// goes through the native Tauri event bus instead of the `@janhq/core`
/// in-process EventEmitter. Having a parallel Tauri-level signal avoids
/// losing UI-sync when the web-app happens to bundle a different `events`
/// singleton than the extension does.
const AUTO_INCREASE_CTX_NOTIFY = 'local_backend://auto_increase_ctx_notify'
/// Broadcast channel emitted when auto-expand hits the model's true
/// training-max context (or when the next ladder step doesn't grow the
/// window further). The web-app uses this to show a one-shot toast and
/// stop driving further regeneration attempts.
const AUTO_INCREASE_CTX_AT_MAX = 'local_backend://auto_increase_ctx_at_max'

/// The caller asked to download the `latest/<backend>` sentinel instead of a
/// concrete release tag. The download is refused before it reaches the core,
/// so this is a routing defect to fix, not a crash.
const ERR_BACKEND_TAG_UNRESOLVED = 'BACKEND_TAG_UNRESOLVED'
const CORE_SETTINGS_CHANGED_EVENT = 'atomic-core://settings:changed'

/// What the core writes into `model.yml` for a model this engine runs. A model
/// without it belongs to the upstream / TurboQuant providers.
const PRISM_ATOMIC_RUNTIME = { provider: 'atomic-prism' } as const

const logger = {
  info: function (...args: any[]) {
    console.log('[atomic-prism]', ...args)
    info(`[atomic-prism]${args.map((arg) => ` ${arg}`).join(` `)}`)
  },
  warn: function (...args: any[]) {
    console.warn('[atomic-prism]', ...args)
    warn(`[atomic-prism]${args.map((arg) => ` ${arg}`).join(` `)}`)
  },
  error: function (...args: any[]) {
    console.error('[atomic-prism]', ...args)
    error(`[atomic-prism]${args.map((arg) => ` ${arg}`).join(` `)}`)
  },
}

const PRISM_BACKEND_TYPE_KEY = 'atomic_prism_backend_type'
/// A backend downloaded before the last restart and not yet activated. Every
/// llama.cpp provider keeps its own key, so one never activates another's build.
const PENDING_BACKEND_KEY = 'atomic_prism_pending_backend'
/// Read by the web app's `useBackendUpdater` for this provider. Its own key:
/// the upstream one is cleared and rewritten by `llamacpp-upstream`.
const BETTER_BACKEND_RECOMMENDATION_KEY =
  'atomic_prism_better_backend_recommendation'

/**
 * Coerce an unknown error into a human-readable string.
 *
 * Tauri commands reject with a structured `{ code, message, details }` object,
 * which is NOT an `Error` instance. Naive string coercion (`String(err)` /
 * `` `${err}` ``) therefore yields `"[object Object]"` (see ATO-117). Prefer
 * `message`, append `details` when present, then fall back to
 * `JSON.stringify` and finally `String`. Never returns `"[object Object]"`.
 */
function formatLoadError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err)
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; details?: unknown }
    const parts: string[] = []
    if (typeof e.message === 'string' && e.message.trim())
      parts.push(e.message.trim())
    if (typeof e.details === 'string' && e.details.trim())
      parts.push(e.details.trim())
    if (parts.length > 0) {
      const code = typeof e.code === 'string' && e.code ? ` [${e.code}]` : ''
      return `${parts.join('\n')}${code}`
    }
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}' && json !== 'null') return json
    } catch {
      /* fall through to String() */
    }
  }
  return String(err)
}

/**
 * Build an `Error` carrying a `code` own-property, so callers can branch on the
 * cause instead of matching the message text.
 */
function codedLoadError(
  code: string,
  message: string
): Error & { code: string } {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

function stripBom(s: string): string {
  return s.replace(/\uFEFF/g, '').trim()
}

/**
 * The newest `version/backend` of one backend type in the catalog, or `null`
 * when the catalog has none. The core answers this as `latest_by_type`; without
 * a catalog (core unreachable) the installed packs are scanned by exact type
 * and PrismML build number.
 */
function findLatestVersionForBackend(
  catalog: coreRuntime.CoreBackendCatalog | null,
  fallback: { version: string; backend: string }[],
  backendType: string
): string | null {
  if (catalog) return catalog.latest_by_type[backendType] ?? null
  let best: { version: string; backend: string } | null = null
  for (const entry of fallback) {
    if (stripBom(entry.backend) !== backendType) continue
    if (
      !best ||
      (prismTagBuild(entry.version) ?? -1) > (prismTagBuild(best.version) ?? -1)
    ) {
      best = entry
    }
  }
  return best ? `${stripBom(best.version)}/${stripBom(best.backend)}` : null
}

// Folder structure for this provider:
// <Jan's data folder>/llamacpp/models/<modelId>/model.yml — SHARED with the
//   upstream and TurboQuant providers; a Bonsai model carries
//   `atomic_runtime: { provider: 'atomic-prism' }` and lists only here.
// <Jan's data folder>/atomic-prism/backends/<tag>/<backend>/build/bin/llama-server

/**
 * The on-disk subfolder every llama.cpp provider uses for model storage. Only
 * the GGUF tree is shared; backends and provider settings stay under each
 * provider's own folder.
 */
const MODELS_PROVIDER_ROOT = 'llamacpp'

/**
 * What `recheckOptimalBackend()` hands the web app when the core found a better
 * build: the shape `useBackendUpdater` / `SuboptimalBackendDialog` read from
 * `atomic_prism_better_backend_recommendation` and `AppEvent.onBetterBackendDetected`.
 * The core's `recommendation` payload has the same fields; `provider` is
 * re-stamped here so a payload can never carry another provider's id.
 */
type BetterBackendPayload = {
  currentBackend: string
  recommendedBackend: string
  recommendedCategory: string
  provider: string
  version: string
  backendId: string
}

/**
 * The core's update check for this provider. The shared type predates the
 * PrismML fields, so they are declared here and read defensively: the core
 * leaves out whatever the manifest does not carry.
 */
type PrismBackendUpdateCheck = coreRuntime.CoreBackendUpdateCheck & {
  reason?: 'newer' | 'withdrawn' | 'model_requires'
  notes_url?: string
  notes?: string
  download_size?: number
  current_withdrawn?: { reason?: string }
}

/** `checkBackendForUpdates()`'s answer, in the app's words. */
type BackendUpdateCheckResult = {
  updateNeeded: boolean
  newVersion: string
  targetBackend?: string
  sameFamily: boolean
  reason?: string
  notesUrl?: string
  notes?: string
  downloadSize?: number
  /** Why the release in use was pulled, when it was. */
  currentWithdrawn?: string
}

/**
 * Bound on one `recommendation` round trip to the core. Above the core's own
 * 20 s detection guard, so the core decides `detection_failed` first and this
 * only catches a core that stopped answering altogether.
 */
const RECOMMENDATION_TIMEOUT_MS = 30_000

/// The app's version as `@tauri-apps/api/app` reports it, asked once. The core
/// gates catalog entries on the app version, so it travels with every
/// catalog / recommendation / updates call; a failed lookup passes `null`, which
/// the core treats as "no gate" rather than refusing every release.
let cachedAppVersion: string | null = null
async function appVersion(): Promise<string | null> {
  if (cachedAppVersion) return cachedAppVersion
  try {
    cachedAppVersion = await getVersion()
    return cachedAppVersion
  } catch (err) {
    logger.warn('[appVersion] unavailable, catalog calls carry no app version:', err)
    return null
  }
}

export const OPTIMAL_BACKEND_CACHE_KEY = 'atomic_prism_optimal_backend_v1'

type OptimalBackendCacheBase = {
  schemaVersion: 1
  provider: 'atomic-prism'
  detectedAt: number
  currentBackend: string
  recommendedCategory: string
}

export type OptimalBackendCacheRecord =
  | (OptimalBackendCacheBase & {
      detectionKind: 'gpu'
      idealBackendId: string
      recommendedBackend?: string
    })
  | (OptimalBackendCacheBase & {
      detectionKind: 'cpu-optimal'
    })

/**
 * Sentinel `Error.message` thrown by `recheckOptimalBackend()` when backend
 * detection could not complete (ATO-161). Callers match on this to show a
 * "couldn't detect — keeping current backend" message instead of silently
 * treating it as "CPU is optimal". The web-app handler matches the literal
 * value (it can't import the extension bundle), so keep the two in sync.
 */
export const BACKEND_DETECTION_FAILED = 'BACKEND_DETECTION_FAILED'

export default class atomic_prism_extension extends AIEngine {
  provider: string = 'atomic-prism'
  autoUnload: boolean = false
  timeout: number = 1800
  llamacpp_env: string = ''
  readonly providerId: string = 'atomic-prism'

  private config: PrismConfig
  private providerPath!: string
  private isConfiguringBackends: boolean = false
  private isUpdatingBackend: boolean = false
  private isInitializing: boolean = true
  private configureBackendsPromise: Promise<void> | null = null
  private isMirroringCoreSettings = false
  /// Hidden until the core says otherwise: where PrismML publishes no build for this machine
  /// (Linux and Windows on Arm) there is nothing to set up, and the provider must not flash up.
  private hidden = true
  /// Whether `hidden` is the core's answer, or only the default nobody has confirmed yet.
  private known = false
  /// The visibility check in flight, shared by every caller that asks while it runs.
  private visibilityCheck?: Promise<boolean>
  /// Import once per core attachment and settings state; mirror the core's values back.
  private readonly coreSettings = createCoreSettingsSync({
    core: coreRuntime,
    readSettings: async () =>
      (await this.getSettings()) as unknown as PersistedSetting[],
    writeSettings: (settings) => this.updateSettings(settings as never),
    setMirroring: (active) => {
      this.isMirroringCoreSettings = active
    },
  })
  /// A model's trained context length as the core reads it from the GGUF
  /// (`{general.architecture}.context_length`). It is a property of the file,
  /// so it is asked once per model and kept for the life of the extension.
  private modelMaxCtxTrain = new Map<string, number>()
  /// ATO-530: loads in flight and the cancels aimed at them, on top of the core's load.
  private readonly loadCancel = new LoadCancelTracker(coreRuntime, (message) =>
    logger.warn(message)
  )
  private unlistenValidationStarted?: () => void
  private unlistenAutoIncreaseCtx?: () => void
  private unlistenCoreSettingsChanged?: () => void
  private unlistenCoreOptimalChanged?: () => void
  private unlistenCoreSnapshot?: () => void
  private unlistenCoreDetached?: () => void
  private optimalRevision = 0
  private optimalEpoch = 0

  /**
   * Returns the provider-scoped optimal-backend cache when its schema and
   * required fields are valid. Invalid or stale-shaped values are ignored.
   */
  getCachedOptimalBackend(): OptimalBackendCacheRecord | null {
    try {
      const raw = localStorage.getItem(OPTIMAL_BACKEND_CACHE_KEY)
      if (!raw) return null

      const value = JSON.parse(raw) as Record<string, unknown>
      if (
        value.schemaVersion !== 1 ||
        value.provider !== 'atomic-prism' ||
        !Number.isFinite(value.detectedAt) ||
        (value.detectedAt as number) < 0 ||
        typeof value.currentBackend !== 'string' ||
        typeof value.recommendedCategory !== 'string' ||
        !value.recommendedCategory
      ) {
        return null
      }

      if (value.detectionKind === 'gpu') {
        const recommendedType =
          typeof value.recommendedBackend === 'string'
            ? stripBom(value.recommendedBackend).split('/')[1]
            : undefined
        if (
          typeof value.idealBackendId !== 'string' ||
          !value.idealBackendId ||
          (value.recommendedBackend !== undefined &&
            (typeof value.recommendedBackend !== 'string' ||
              !isConcreteVersionBackend(value.recommendedBackend) ||
              recommendedType !== stripBom(value.idealBackendId)))
        ) {
          return null
        }
        return value as OptimalBackendCacheRecord
      }
      if (value.detectionKind === 'cpu-optimal') {
        if (
          value.idealBackendId !== undefined ||
          value.recommendedBackend !== undefined
        ) {
          return null
        }
        return value as OptimalBackendCacheRecord
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Mirror the core's optimal-backend record into the synchronous UI copy.
   *
   * The core stores the record itself, inside `recommendation` (ADR 2026-09-27); this process only
   * follows its `{revision, optimal}`, so the UI never shows a result the core has not committed and
   * an older revision never overwrites a newer one.
   */
  private applyOptimalState(state: coreRuntime.CoreOptimalState<OptimalBackendCacheRecord>): void {
    if (state.revision < this.optimalRevision) return
    this.optimalRevision = state.revision
    if (state.optimal) localStorage.setItem(OPTIMAL_BACKEND_CACHE_KEY, JSON.stringify(state.optimal))
    else localStorage.removeItem(OPTIMAL_BACKEND_CACHE_KEY)
  }

  /**
   * Take the core's stored detection as this process's own.
   *
   * Run once at startup, before anything reads the cache: the core may hold a detection made by the
   * CLI or by a previous run of the app, and `localStorage` may hold one made on different
   * hardware. The core's copy sits beside the data folder it describes, so it wins.
   */
  private async adoptOptimalFromCore(): Promise<void> {
    const epoch = this.optimalEpoch
    try {
      const stored = await coreRuntime.getOptimalSnapshot<OptimalBackendCacheRecord>()
        ?? await coreRuntime.getOptimalCache<OptimalBackendCacheRecord>()
      if (epoch === this.optimalEpoch) this.applyOptimalState(stored)
    } catch (error) {
      logger.warn(
        `[atomic-core] could not read the optimal-backend record: ${coreRuntime.describeCoreError(error)}`
      )
    }
  }

  override async onLoad(): Promise<void> {
    super.onLoad() // Calls registerEngine() from AIEngine

    let settings = structuredClone(SETTINGS) // Clone to modify settings definition before registration

    // Preserve persisted `version_backend` across sessions.
    //
    // `registerSettings()` (in core extension.ts) keeps the persisted value
    // ONLY if the new `options` list contains it; otherwise it silently
    // resets value to `options[0]`. `SETTINGS` arrives with empty options, so
    // without this the user's selected build would be wiped on every cold
    // start. Inject the persisted value into the options list first so the
    // deduplication check passes and the value survives.
    try {
      const persistedSettings = await this.getSettings()
      const persistedVbRaw = persistedSettings.find(
        (s) => s.key === 'version_backend'
      )?.controllerProps?.value
      const persistedVb =
        typeof persistedVbRaw === 'string' ? stripBom(persistedVbRaw) : ''
      if (persistedVb && persistedVb !== 'none' && persistedVb.includes('/')) {
        const vbSetting = settings.find((s) => s.key === 'version_backend')
        if (vbSetting && 'options' in vbSetting.controllerProps) {
          vbSetting.controllerProps.options = [
            { value: persistedVb, name: persistedVb },
          ]
          vbSetting.controllerProps.value = persistedVb
          logger.info(
            `[onLoad] Preserving persisted version_backend across registerSettings: ${persistedVb}`
          )
        }
      }
    } catch (err) {
      logger.warn(
        '[onLoad] Failed to read persisted settings for version_backend preservation:',
        err
      )
    }

    // This makes the settings (including the backend options and initial value) available to the Jan UI.
    this.registerSettings(settings)

    let loadedConfig: any = {}
    for (const item of settings) {
      const defaultValue = item.controllerProps.value
      // Use the potentially updated default value from the settings array as the fallback for getSetting
      loadedConfig[item.key] = await this.getSetting<typeof defaultValue>(
        item.key,
        defaultValue
      )
    }
    this.config = loadedConfig as PrismConfig

    // Strip any BOM characters persisted from earlier PowerShell-generated files
    if (this.config.version_backend) {
      const cleaned = stripBom(this.config.version_backend)
      if (cleaned !== this.config.version_backend) {
        this.config.version_backend = cleaned
        const allSettings = await this.getSettings()
        await this.updateSettings(
          allSettings.map((item) => {
            if (item.key === 'version_backend') {
              item.controllerProps.value = cleaned
            }
            return item
          })
        )
        logger.info(`Cleaned BOM from version_backend: "${cleaned}"`)
      }
    }

    this.timeout = this.config.timeout
    this.llamacpp_env = this.config.llamacpp_env
    this.autoUnload = this.config.auto_unload ?? true

    // This sets the base directory where model files for this provider are stored.
    this.getProviderPath()

    // Activate a pending backend that was downloaded before the last restart.
    await this.activatePendingBackend()

    // ATO-179: sweep orphan / incomplete backend folders (exist on disk but
    // carry no llama-server exe — e.g. empty stubs from a failed download) so
    // they neither masquerade as installed nor block a clean re-download.
    try {
      const removed = await cleanupIncompleteBackends()
      if (removed.length > 0) {
        logger.info(
          `[onLoad] Cleaned ${removed.length} incomplete/orphan backend dir(s): ${removed.join(', ')}`
        )
      }
    } catch (cleanupErr) {
      logger.warn('[onLoad] Incomplete-backend cleanup failed:', cleanupErr)
    }

    // Set up validation event listeners to bridge Tauri events to frontend
    this.unlistenValidationStarted = await listen<{
      modelId: string
      downloadType: string
    }>('onModelValidationStarted', (event) => {
      console.debug(
        '[atomic-prism] bridging onModelValidationStarted event',
        event.payload
      )
      events.emit(DownloadEvent.onModelValidationStarted, event.payload)
    })

    // Local API Server auto-increase-ctx bridge. The Rust proxy fires this
    // event whenever a forwarded request hits a context-limit error; we
    // reply on a request-scoped channel so the proxy can retry transparently
    // (see `proxy.rs::maybe_auto_increase_and_retry`).
    this.unlistenAutoIncreaseCtx = await listen<AutoIncreaseCtxRequest>(
      AUTO_INCREASE_CTX_EVENT,
      (event) => {
        // The Rust proxy emits `backend: 'atomic-prism'` for PrismML sessions;
        // only those events belong to this extension. The other llama.cpp
        // providers and MLX answer their own.
        if (event.payload?.backend !== 'atomic-prism') return
        void this.handleAutoIncreaseCtx(event.payload)
      }
    )

    // Keep the app's copy of the settings — what the settings UI reads — current when a CLI changes
    // them in the core. Acknowledge is sent only after updateSettings has persisted the values in
    // the extension storage.
    this.unlistenCoreSettingsChanged = await listen(
      CORE_SETTINGS_CHANGED_EVENT,
      (event: { payload?: { provider?: string } }) => {
        // Import and acknowledge also change migration bookkeeping under the `state` scope. If
        // those events were mirrored, each acknowledge would create a new revision and trigger
        // another acknowledge forever. Only provider values belong in the app's copy.
        if (event.payload?.provider !== this.provider) return
        void this.coreSettings.mirror().catch((error) => {
          logger.warn(
            `[atomic-core] could not mirror changed settings: ${coreRuntime.describeCoreError(error)}`
          )
        })
      }
    )

    this.unlistenCoreOptimalChanged = await listen(
      'atomic-core://backend:optimal-changed',
      (event: { payload?: { provider?: string; revision?: number; optimal?: OptimalBackendCacheRecord | null } }) => {
        const state = event.payload
        if (state?.provider !== this.provider || typeof state.revision !== 'number') return
        this.applyOptimalState({ revision: state.revision, optimal: state.optimal ?? null })
      }
    )
    this.unlistenCoreSnapshot = await listen(
      'atomic-core://snapshot',
      (event: { payload?: { snapshot?: { optimal_backends?: Record<string, coreRuntime.CoreOptimalState<OptimalBackendCacheRecord>> } } }) => {
        // A snapshot is the new baseline. Invalidate checks still pending from the old stream.
        this.optimalEpoch++
        const state = event.payload?.snapshot?.optimal_backends?.[this.provider]
        this.applyOptimalState(state ?? { revision: 0, optimal: null })
      }
    )
    // The next attachment answers with a snapshot of its own; until then the old record is not
    // known to be committed anywhere, so the UI copy goes with it.
    this.unlistenCoreDetached = await listen('atomic-core://detached', () => {
      this.optimalEpoch++
      this.optimalRevision = 0
      localStorage.removeItem(OPTIMAL_BACKEND_CACHE_KEY)
    })
    await this.adoptOptimalFromCore()

    // Not awaited, like the catalog below: the app's DataProvider waits for this check and then
    // updates the provider list.
    void this.refreshVisibility()

    // Not awaited: the catalog round trip must not hold the UI up.
    this.configureBackendsPromise = this.configureBackends()
      .catch((err) => {
        logger.error('configureBackends failed:', err)
      })
      // Offer a newer release once the configured build is known.
      .then(() => this.reconcileBackendReleaseTag())
      .finally(() => {
        this.isInitializing = false
        this.configureBackendsPromise = null
      })
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  /** Whether the provider stays out of the app's lists, as of the last core answer. */
  isHidden(): boolean {
    return this.hidden
  }

  /**
   * Whether the core has answered at least once. A check that fails keeps the last answer; before
   * any answer the provider stays hidden, but that is not a reason to forget it.
   */
  visibilityKnown(): boolean {
    return this.known
  }

  /**
   * Ask the core again whether PrismML publishes a build this machine can run; `true` when the
   * provider should be shown. The answer is the catalog's `supported_backends`: the core maps the
   * machine to PrismML's archive names, and an empty list means no build exists for it. A call
   * made while a check runs waits for that check rather than starting another.
   */
  refreshVisibility(): Promise<boolean> {
    this.visibilityCheck ??= this.probeVisibility().finally(() => {
      this.visibilityCheck = undefined
    })
    return this.visibilityCheck
  }

  private async probeVisibility(): Promise<boolean> {
    try {
      this.applyVisibility(await loadCatalog({ appVersion: await appVersion() }))
    } catch (error) {
      // A core restarting or unreachable says nothing about the machine: keep the last answer.
      logger.warn(
        `PrismML availability could not be checked: ${coreRuntime.describeCoreError(error)}`
      )
    }
    return !this.hidden
  }

  private applyVisibility(catalog: coreRuntime.CoreBackendCatalog): void {
    this.hidden = catalog.supported_backends.length === 0
    this.known = true
  }

  /**
   * What the provider page shows while PrismML's engine is not installed: whether the core has a
   * pack on disk, and the build it would install on this machine — `null` when none is offered
   * (no verified build yet and `allow_candidate_builds` off). The packs are listed again, so an
   * install that just finished counts.
   */
  async getEngineStatus(): Promise<{
    installed: boolean
    recommended: string | null
  }> {
    const catalog = await loadCatalog({
      refresh: true,
      appVersion: await appVersion(),
    })
    this.applyVisibility(catalog)
    const [best] = [...catalog.available].sort(
      (a, b) => (b.order ?? 0) - (a.order ?? 0)
    )
    return {
      installed: catalog.installed.length > 0,
      recommended:
        catalog.recommended ?? (best ? `${best.version}/${best.backend}` : null),
    }
  }

  /**
   * `allow_candidate_builds` decides what the core offers: its catalog, its update checks and the
   * Hub's model setup plan read the core's own copy of the setting, which hears of a change only
   * when the settings are imported — before a model load, otherwise. Import now, then rebuild the
   * version list from the catalog the new value gives.
   */
  private async applyCandidateBuildsChange(): Promise<void> {
    try {
      await this.coreSettings.ensureReady()
      await this.configureBackends()
    } catch (error) {
      logger.warn(
        `[allow_candidate_builds] could not hand the change to the core: ${coreRuntime.describeCoreError(error)}`
      )
    }
  }

  private getStoredBackendType(): string | null {
    try {
      const value = localStorage.getItem(PRISM_BACKEND_TYPE_KEY)
      return value ? stripBom(value) : null
    } catch (error) {
      logger.warn('Failed to read backend type from localStorage:', error)
      return null
    }
  }

  private setStoredBackendType(backendType: string): void {
    try {
      localStorage.setItem(PRISM_BACKEND_TYPE_KEY, backendType)
      logger.info(`Stored backend type preference: ${backendType}`)
    } catch (error) {
      logger.warn('Failed to store backend type in localStorage:', error)
    }
  }

  private clearStoredBackendType(): void {
    try {
      localStorage.removeItem(PRISM_BACKEND_TYPE_KEY)
      logger.info('Cleared stored backend type preference')
    } catch (error) {
      logger.warn('Failed to clear backend type from localStorage:', error)
    }
  }

  private async activatePendingBackend(): Promise<void> {
    const pending = localStorage.getItem(PENDING_BACKEND_KEY)
    if (!pending) return

    const cleaned = stripBom(pending)
    const parts = cleaned.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      logger.warn(`Invalid pending backend string "${cleaned}", clearing`)
      localStorage.removeItem(PENDING_BACKEND_KEY)
      return
    }

    const [version, backend] = [parts[0].trim(), parts[1].trim()]

    try {
      const installed = await isBackendInstalled(backend, version)
      if (!installed) {
        logger.warn(`Pending backend ${cleaned} not found on disk, clearing`)
        localStorage.removeItem(PENDING_BACKEND_KEY)
        return
      }

      logger.info(
        `Activating pending backend from previous download: ${cleaned}`
      )
      const result = await this.updateBackend(cleaned)
      if (result.wasUpdated) {
        logger.info(`Pending backend ${cleaned} activated successfully`)
      } else {
        logger.warn(`Failed to activate pending backend ${cleaned}`)
      }
    } catch (err) {
      logger.error('Error activating pending backend:', err)
    } finally {
      localStorage.removeItem(PENDING_BACKEND_KEY)
    }
  }

  /**
   * Builds the `version_backend` dropdown from the core's catalog and the packs
   * on disk, and settles which build is configured.
   *
   * No build ships inside the app for this provider: with no catalog and
   * nothing installed, `version_backend` stays `none` until the user picks a
   * build (the core downloads it at the first load).
   *
   * GPU-backend detection does not run here; it is driven from outside the
   * extension through `refreshOptimalBackendCache()` / `recheckOptimalBackend()`.
   */
  async configureBackends(): Promise<void> {
    if (this.isConfiguringBackends) {
      logger.info(
        'configureBackends already in progress, skipping duplicate call'
      )
      return
    }

    this.isConfiguringBackends = true

    try {
      // Sanitize any BOM characters left over from previous sessions
      if (this.config.version_backend) {
        this.config.version_backend = stripBom(this.config.version_backend)
      }

      // The persisted UI settings can be lost between launches (WebView
      // storage wiped, factory reset) while a build is still installed. The
      // core ranks what is on disk as `recommended_installed`; that pick is
      // applied below once the catalog has answered.
      const currentVB = this.config.version_backend || ''
      const persistedMissing =
        !currentVB || currentVB === 'none' || !currentVB.includes('/')

      let version_backends: {
        version: string
        backend: string
        order?: number
      }[] = []
      // The core's answer, or `null` when it could not be reached — every
      // decision below then falls back to the installed packs alone.
      let catalog: coreRuntime.CoreBackendCatalog | null = null

      try {
        logger.info('[configureBackends] Fetching the backend catalog from the core...')
        // `refresh`: the packs on disk may have changed since the last answer (a backend installed
        // from a file never passes through the core), and this method decides from what is installed.
        catalog = await loadCatalog({ refresh: true, appVersion: await appVersion() })
        this.applyVisibility(catalog)
        version_backends = [...catalog.available].sort(
          (a, b) => (b.order ?? 0) - (a.order ?? 0)
        )
        logger.info(
          `[configureBackends] Got ${version_backends.length} backends: ${version_backends.map((b) => `${b.version}/${b.backend}`).join(', ')}`
        )
      } catch (error) {
        catalog = null
        logger.warn(
          `[configureBackends] The core's catalog is unavailable (${
            error instanceof Error ? error.message : coreRuntime.describeCoreError(error)
          }); offering installed builds only`
        )
        try {
          version_backends = await getLocalInstalledBackends()
        } catch {
          version_backends = []
        }
      }

      // Disk recovery (see `persistedMissing` above): the settings arrived
      // without a backend, but the core ranks one of the installed packs as
      // worth running. Persisted too, so the core loads on the build the UI shows.
      if (persistedMissing && catalog?.recommended_installed) {
        const recovered = catalog.recommended_installed
        if (recovered.includes('/')) {
          this.config.version_backend = recovered
          const recoveredType = recovered.split('/')[1]
          if (recoveredType) {
            this.setStoredBackendType(recoveredType)
          }
          const recoveredSettings = await this.getSettings()
          await this.updateSettings(
            recoveredSettings.map((item) => {
              if (item.key === 'version_backend') {
                item.controllerProps.value = recovered
              }
              return item
            })
          )
          logger.info(
            `[configureBackends] Recovered version_backend from disk: ${recovered} (localStorage was empty)`
          )
        }
      }

      // Get stored backend preference
      const storedBackendType = this.getStoredBackendType()

      // The core ranks the catalog; without a catalog the newest installed
      // pack is the only candidate.
      let bestAvailableBackendString = catalog
        ? (catalog.recommended ?? '')
        : version_backends[0]
          ? `${version_backends[0].version}/${version_backends[0].backend}`
          : ''
      logger.info(
        `[configureBackends] Best backend: ${bestAvailableBackendString || '(none)'}, storedType: ${storedBackendType || '(none)'}`
      )

      if (storedBackendType) {
        const preferredBackendString = findLatestVersionForBackend(
          catalog,
          version_backends,
          storedBackendType
        )
        if (preferredBackendString) {
          bestAvailableBackendString = preferredBackendString
          logger.info(
            `Using stored backend preference: ${bestAvailableBackendString}`
          )
        } else {
          // The catalog may be temporarily unreachable; keep the preference.
          logger.warn(
            `Stored backend type '${storedBackendType}' not in the catalog right now; keeping preference`
          )
        }
      }

      // Whether the currently-saved version_backend is on disk: it keeps the
      // saved option visible when the catalog does not list it, and prevents
      // the fresh-installation fallback from replacing a working build.
      const savedVB = stripBom(this.config.version_backend || '')
      const [savedVbVer, savedVbBack] = savedVB.split('/')
      const savedVbIsInstalled =
        !!savedVbVer?.trim() &&
        !!savedVbBack?.trim() &&
        savedVB.includes('/') &&
        (await isBackendInstalled(savedVbBack.trim(), savedVbVer.trim()))

      let settings = structuredClone(SETTINGS)
      const backendSettingIndex = settings.findIndex(
        (item) => item.key === 'version_backend'
      )

      let originalDefaultBackendValue = ''
      if (backendSettingIndex !== -1) {
        const backendSetting = settings[backendSettingIndex]
        originalDefaultBackendValue = backendSetting.controllerProps
          .value as string

        // Two tiers: the catalog for this host (the PrismML manifest merged
        // with the disk and gated by hardware), then whatever else is on disk,
        // so a side-loaded or withdrawn build stays switchable.
        const catalogEntries = version_backends.map((b) => {
          const key = `${b.version}/${b.backend}`
          return { value: key, name: key }
        })

        let installedEntries: Array<{ value: string; name: string }> = []
        try {
          installedEntries = (await getLocalInstalledBackends()).map((b) => {
            const key = `${b.version}/${b.backend}`
            return { value: key, name: key }
          })
        } catch (err) {
          logger.warn(
            `[configureBackends] Failed to list installed backends: ${coreRuntime.describeCoreError(err)}`
          )
        }

        backendSetting.controllerProps.options = mergeBackendOptions(
          [catalogEntries, installedEntries],
          bestAvailableBackendString
            ? {
                value: bestAvailableBackendString,
                name: bestAvailableBackendString,
              }
            : undefined
        )

        // Always surface the saved backend, even when neither the catalog nor
        // the disk lists it: dropping it hands the value to core's
        // `registerSettings()`, which replaces anything missing from the
        // options with `options[0]`.
        if (
          isConcreteVersionBackend(savedVB) &&
          !(
            backendSetting.controllerProps.options as Array<{
              value: string
              name: string
            }>
          ).some((o) => o.value === savedVB)
        ) {
          backendSetting.controllerProps.options = [
            { value: savedVB, name: savedVB },
            ...(backendSetting.controllerProps.options as Array<{
              value: string
              name: string
            }>),
          ]
          logger.info(
            `Saved backend ${savedVB} not present in the catalog — pinning it into options (installed locally: ${savedVbIsInstalled})`
          )
        }

        if (bestAvailableBackendString) {
          backendSetting.controllerProps.recommended =
            bestAvailableBackendString
        }

        const savedBackendSetting = await this.getSetting<string>(
          'version_backend',
          originalDefaultBackendValue
        )

        // Initial UI default: the saved setting (moved to the newest release
        // of its type), else the best available, else the schema default.
        let initialUiDefault = originalDefaultBackendValue

        if (
          savedBackendSetting &&
          savedBackendSetting !== originalDefaultBackendValue
        ) {
          const [savedVersion, savedBackend] = savedBackendSetting.split('/')
          if (savedVersion && savedBackend) {
            const latestForType = findLatestVersionForBackend(
              catalog,
              version_backends,
              savedBackend
            )
            initialUiDefault = latestForType || `${savedVersion}/${savedBackend}`

            if (this.getStoredBackendType() !== savedBackend) {
              this.setStoredBackendType(savedBackend)
              logger.info(
                `Stored backend type preference from saved setting: ${savedBackend}`
              )
            }
          }
        } else if (bestAvailableBackendString) {
          initialUiDefault = bestAvailableBackendString
          const [, backendType] = bestAvailableBackendString.split('/')
          if (backendType && this.getStoredBackendType() !== backendType) {
            this.setStoredBackendType(backendType)
            logger.info(
              `Stored backend type preference from best available: ${backendType}`
            )
          }
        }

        backendSetting.controllerProps.value = initialUiDefault
        logger.info(
          `Initial UI default for version_backend set to: ${initialUiDefault}`
        )
      } else {
        logger.error(
          'Critical setting "version_backend" definition not found in SETTINGS.'
        )
        throw new Error('Critical setting "version_backend" not found.')
      }

      this.registerSettings(settings)

      // First complete option list of the session: nothing else announces it,
      // so without this the dropdown keeps the list `onLoad` registered.
      if (events && typeof events.emit === 'function') {
        events.emit('settingsChanged', {
          key: 'version_backend',
          value: String(
            settings[backendSettingIndex].controllerProps.value ?? ''
          ),
        })
      }

      let effectiveBackendString = stripBom(this.config.version_backend || '')

      // Move to the newest *installed* release of the same backend type. A
      // newer release that is not on disk yet is offered by
      // `reconcileBackendReleaseTag()`, never downloaded from here.
      if (
        effectiveBackendString &&
        bestAvailableBackendString &&
        effectiveBackendString !== bestAvailableBackendString &&
        effectiveBackendString.includes('/')
      ) {
        const currentType = effectiveBackendString.split('/')[1]?.trim()
        const bestType = bestAvailableBackendString.split('/')[1]?.trim()
        if (currentType && bestType && currentType === bestType) {
          const [bestVer, bestBack] = bestAvailableBackendString.split('/')
          const bestIsInstalled =
            !!bestVer?.trim() &&
            !!bestBack?.trim() &&
            (await isBackendInstalled(bestBack.trim(), bestVer.trim()))

          if (!bestIsInstalled) {
            logger.info(
              `Skipping auto-upgrade ${effectiveBackendString} → ${bestAvailableBackendString}: target not installed locally`
            )
          } else {
            logger.info(
              `Auto-upgrading backend to latest version: ${effectiveBackendString} → ${bestAvailableBackendString}`
            )
            effectiveBackendString = bestAvailableBackendString

            this.config.version_backend = effectiveBackendString

            const updatedSettings = await this.getSettings()
            await this.updateSettings(
              updatedSettings.map((item) => {
                if (item.key === 'version_backend') {
                  item.controllerProps.value = effectiveBackendString
                }
                return item
              })
            )

            if (events && typeof events.emit === 'function') {
              events.emit('settingsChanged', {
                key: 'version_backend',
                value: effectiveBackendString,
              })
            }
          }
        }
      }

      // Fresh installation, or the saved backend is genuinely gone from disk
      // and from the catalog: take the best available build, when there is one.
      const savedNotInList =
        !!effectiveBackendString &&
        effectiveBackendString.includes('/') &&
        !version_backends.some(
          (e) => `${e.version}/${e.backend}` === effectiveBackendString
        )
      const savedBackendVanished =
        !effectiveBackendString ||
        effectiveBackendString === 'none' ||
        !effectiveBackendString.includes('/') ||
        (savedNotInList && !savedVbIsInstalled)

      if (savedBackendVanished && bestAvailableBackendString) {
        effectiveBackendString = bestAvailableBackendString
        logger.info(
          `Fresh installation or invalid backend detected, using: ${effectiveBackendString}`
        )

        this.config.version_backend = effectiveBackendString

        const updatedSettings = await this.getSettings()
        await this.updateSettings(
          updatedSettings.map((item) => {
            if (item.key === 'version_backend') {
              item.controllerProps.value = effectiveBackendString
            }
            return item
          })
        )
        logger.info(`Updated UI settings to show: ${effectiveBackendString}`)

        if (events && typeof events.emit === 'function') {
          events.emit('settingsChanged', {
            key: 'version_backend',
            value: effectiveBackendString,
          })
        }
      } else if (savedNotInList && savedVbIsInstalled) {
        logger.warn(
          `Saved backend ${effectiveBackendString} not in the catalog but installed locally — keeping it active`
        )
      }
    } finally {
      this.isConfiguringBackends = false
    }
  }

  /**
   * Offers the newest PrismML release the core approves for the configured
   * backend type. Never downloads: the web app's `<EngineUpdateBanner />` asks,
   * and accepting routes back through `downloadRecommendedBackend()`.
   *
   * The core answers with the target's release page, its note and its download
   * size, and says when the release in use was withdrawn (its offer is then the
   * newest approved build of the same type, possibly an older tag).
   */
  private async reconcileBackendReleaseTag(): Promise<void> {
    try {
      const current = stripBom(this.config.version_backend || '')

      if (!isConcreteVersionBackend(current)) {
        logger.info(
          'reconcileBackendReleaseTag: no concrete backend configured yet, skipping'
        )
        return
      }

      const currentType = current.slice(current.indexOf('/') + 1)

      // Only a build on disk has anything to update. `configureBackends()`
      // names the catalog's pick on a machine that never set PrismML up, and
      // a newer release must not reach that user as an "update".
      const currentTag = current.slice(0, current.indexOf('/'))
      if (!(await isBackendInstalled(currentType.trim(), currentTag.trim()))) {
        logger.info(
          `reconcileBackendReleaseTag: ${current} is not installed, nothing to update`
        )
        return
      }

      const check = await this.checkBackendForUpdates()
      if (check.currentWithdrawn) {
        logger.warn(
          `reconcileBackendReleaseTag: the release in use (${current}) was withdrawn: ${check.currentWithdrawn}`
        )
      }
      const { updateNeeded, targetBackend, sameFamily } = check
      const targetType = targetBackend?.split('/')[1]?.trim()
      if (!updateNeeded || !targetBackend || !targetType) return

      // A tag bump must never move anyone between backend types. The core
      // judges it and says so in `same_family`.
      if (!sameFamily) {
        logger.warn(
          `reconcileBackendReleaseTag: refusing to switch backend type ${currentType} -> ${targetType}`
        )
        return
      }

      logger.info(
        `reconcileBackendReleaseTag: offering '${current}' -> '${targetBackend}' (${check.reason ?? 'newer'})`
      )
      this.offerEngineUpdate(current, targetBackend, {
        notesUrl: check.notesUrl,
        notes: check.notes,
        downloadSize: check.downloadSize,
      })
    } catch (err) {
      logger.error(
        'reconcileBackendReleaseTag: failed to check for a newer release (keeping current backend):',
        err
      )
    }
  }

  /**
   * Publishes a "new engine build available" offer for the banner (ATO-528).
   * A failure to publish costs the banner, not the app — the offer is rebuilt
   * on the next launch because the check that produced it is stateless.
   */
  private offerEngineUpdate(
    currentBackend: string,
    targetBackend: string,
    details: EngineUpdateDetails
  ): void {
    try {
      const offer = buildEngineUpdateOffer(
        this.providerId,
        currentBackend,
        targetBackend,
        details
      )
      if (!offer) {
        logger.warn(
          `offerEngineUpdate: could not describe '${targetBackend}', skipping`
        )
        return
      }
      publishEngineUpdateOffer(offer)
    } catch (err) {
      logger.warn('offerEngineUpdate: failed to publish the offer:', err)
    }
  }

  /**
   * Ensure a concrete `<tag>/<backend>` string is present in the
   * `version_backend` dropdown options, persisting directly to localStorage.
   *
   * `Extension.updateSettings()` (core) only copies `controllerProps.value`,
   * never `controllerProps.options`, and the option list is otherwise rebuilt
   * solely by `configureBackends()`. A hot-swap never re-runs it, so the freshly
   * downloaded backend would end up active but missing from the picker
   * (ATO-218). The option is appended before the value is written.
   */
  private async ensureBackendOption(backendString: string): Promise<void> {
    if (!this.name || !backendString) return
    const settings = await this.getSettings()
    let changed = false
    for (const item of settings) {
      if (item.key !== 'version_backend') continue
      const options = Array.isArray(item.controllerProps.options)
        ? (item.controllerProps.options as Array<{
            value: string
            name: string
          }>)
        : ((item.controllerProps.options = []) as Array<{
            value: string
            name: string
          }>)
      if (!options.some((o) => o.value === backendString)) {
        options.push({ value: backendString, name: backendString })
        changed = true
      }
    }
    if (changed) {
      localStorage.setItem(this.name, JSON.stringify(settings))
      logger.info(
        `[ensureBackendOption] Added ${backendString} to version_backend options`
      )
    }
  }

  async updateBackend(
    targetBackendString: string
  ): Promise<{ wasUpdated: boolean; newBackend: string }> {
    targetBackendString = stripBom(targetBackendString)
    if (this.isUpdatingBackend) {
      logger.warn(
        'Backend update already in progress, skipping new update request'
      )
      // Treat concurrent update requests as a benign no-op and report that no new update
      // was performed, while still returning the current backend value.
      return { wasUpdated: false, newBackend: this.config.version_backend }
    }

    this.isUpdatingBackend = true

    try {
      if (!targetBackendString)
        throw new Error(
          `Invalid backend string: ${targetBackendString} supplied to update function`
        )

      const backendParts = targetBackendString.split('/')

      if (
        backendParts.length !== 2 ||
        !backendParts[0]?.trim() ||
        !backendParts[1]?.trim()
      ) {
        throw new Error(
          `Invalid backend string format: "${targetBackendString}". Expected "version/backend".`
        )
      }

      const [rawVersion, rawBackend] = backendParts
      const version = rawVersion.trim()
      const backend = rawBackend.trim()

      // Normalize the target backend string to use trimmed values
      targetBackendString = `${version}/${backend}`

      logger.info(
        `Updating backend to ${targetBackendString} (backend type: ${backend})`
      )

      await this.ensureBackendReady(backend, version)

      // Add delay on Windows
      if (IS_WINDOWS) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      const currentStoredBackend = this.getStoredBackendType()

      // ATO-218: make sure the freshly-downloaded backend appears as a
      // dropdown option before the value is written.
      await this.ensureBackendOption(targetBackendString)

      // Update settings first — if this fails, we haven't mutated any state yet
      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (item.key === 'version_backend') {
            item.controllerProps.value = targetBackendString
          }
          return item
        })
      )

      if (currentStoredBackend !== backend) {
        this.setStoredBackendType(backend)
      }

      // All critical side effects succeeded — now commit to in-memory config
      this.config.version_backend = targetBackendString
      this.config.device = ''

      logger.info(`Successfully updated to backend: ${targetBackendString}`)

      if (events && typeof events.emit === 'function') {
        events.emit('settingsChanged', {
          key: 'version_backend',
          value: targetBackendString,
        })
      }

      // Clean up older releases of this backend type — best-effort, through the core, which owns
      // this provider's tree. Never touches another provider's packs.
      try {
        await this.removeOldBackendVersions(version, backend)
      } catch (cleanupError) {
        logger.warn('Failed to remove old backend versions:', cleanupError)
      }

      return { wasUpdated: true, newBackend: targetBackendString }
    } catch (error) {
      logger.error('Backend update failed:', error)
      return { wasUpdated: false, newBackend: this.config.version_backend }
    } finally {
      this.isUpdatingBackend = false
    }
  }

  /** Removes every installed release of `backend` other than `keepVersion`. */
  private async removeOldBackendVersions(
    keepVersion: string,
    backend: string
  ): Promise<void> {
    const packs = await coreRuntime.listInstalledBackends(
      `${keepVersion}/${backend}`
    )
    for (const pack of packs) {
      if (pack.active) continue
      if (stripBom(pack.backend) !== backend) continue
      if (stripBom(pack.version) === keepVersion) continue
      await coreRuntime.removeBackend(pack.version, pack.backend)
      logger.info(`Removed old backend ${pack.version}/${pack.backend}`)
    }
  }

  /**
   * Downloads a backend and applies it without restarting the app whenever
   * possible. Called by the frontend when the user confirms the better-backend
   * popup or accepts the engine-update banner.
   *
   * The pending key is written BEFORE the download so an observer reacting to
   * `AppEvent.onBackendDownloadFinished` already sees it; after a successful
   * download `applyBackendLive()` hot-swaps, and on failure the pending key
   * stays for `activatePendingBackend()` on the next launch.
   */
  async downloadRecommendedBackend(backendString: string): Promise<void> {
    backendString = stripBom(backendString)

    // A `latest/<backend>` sentinel never reaches a download URL: resolve it
    // to a concrete `<tag>/<backend>` first (ATO-95).
    if (backendString.startsWith('latest/')) {
      const backendId = backendString.slice('latest/'.length).trim()
      const resolved =
        (await this.resolveLatestBackendString(backendId)) ??
        (await this.newestInstalledOfFamily(backendId))
      if (!resolved) {
        throw new Error(
          `Could not resolve a release for '${backendId}': the PrismML catalog is unreachable and no version of this backend is installed locally.`
        )
      }
      logger.info(
        `downloadRecommendedBackend: resolved sentinel ${backendString} -> ${resolved}`
      )
      backendString = resolved
    }

    logger.info(`downloadRecommendedBackend: downloading ${backendString}`)
    localStorage.setItem(PENDING_BACKEND_KEY, backendString)
    try {
      await this.downloadAndInstallBackend(backendString)
    } catch (err) {
      // Download failed — drop the pending marker so the next app launch
      // doesn't try to "activate" a backend that was never installed.
      localStorage.removeItem(PENDING_BACKEND_KEY)
      throw err
    }
    localStorage.removeItem(BETTER_BACKEND_RECOMMENDATION_KEY)

    try {
      await this.applyBackendLive(backendString)
      logger.info(
        `downloadRecommendedBackend: applied backend ${backendString} live (no restart needed)`
      )
    } catch (err) {
      logger.warn(
        `downloadRecommendedBackend: hot-swap failed for ${backendString}, falling back to pending-restart flow:`,
        err
      )
    }
  }

  /**
   * Apply a freshly-downloaded backend to the running process: swap
   * `version_backend` via `updateBackend()` first, then stop any loaded
   * models, clear the pending marker, and notify the UI via a window event.
   *
   * Order matters: `updateBackend()` must commit the new `version_backend`
   * before any model is unloaded, or the web app's auto-reload of the stopped
   * model would race ahead and start `llama-server` on the old build.
   */
  private async applyBackendLive(backendString: string): Promise<void> {
    let loaded: string[] = []
    try {
      loaded = await this.getLoadedModels()
    } catch (err) {
      logger.warn('applyBackendLive: getLoadedModels failed (continuing):', err)
    }

    const result = await this.updateBackend(backendString)
    if (!result.wasUpdated) {
      throw new Error(
        `updateBackend reported wasUpdated=false for ${backendString}`
      )
    }

    for (const modelId of loaded) {
      try {
        await this.unload(modelId)
      } catch (err) {
        logger.warn(
          `applyBackendLive: failed to unload model ${modelId} (continuing):`,
          err
        )
      }
    }

    localStorage.removeItem(PENDING_BACKEND_KEY)

    // A pending engine-update offer is about this provider's backend, and the
    // backend just changed — whatever it proposed is now either done or stale.
    // The next `reconcileBackendReleaseTag()` republishes it if it still holds.
    clearEngineUpdateOffer(this.providerId)

    if (typeof window !== 'undefined' && window.dispatchEvent) {
      const [swappedVersion, swappedId] = backendString.split('/')
      window.dispatchEvent(
        new CustomEvent('app:backend-hotswapped', {
          detail: {
            backend: backendString,
            provider: this.providerId,
            version: swappedVersion,
            backendId: swappedId,
          },
        })
      )
    }
  }

  /**
   * One `recommendation` round trip to the core, bounded. The core runs the
   * hardware detection under its own 20 s guard and answers `detection_failed`
   * itself; `null` here means the core did not answer in time (or at all),
   * which the callers treat the same way.
   */
  private async askCoreForRecommendation(
    request: Omit<coreRuntime.CoreBackendRecommendationRequest, 'current_backend' | 'app_version' | 'proxy'>
  ): Promise<coreRuntime.CoreBackendRecommendation<OptimalBackendCacheRecord, BetterBackendPayload> | null> {
    return await this.withTimeout(
      coreRuntime.recommendBackend<OptimalBackendCacheRecord, BetterBackendPayload>({
        ...request,
        current_backend: stripBom(this.config.version_backend || ''),
        app_version: await appVersion(),
        proxy: (getProxyConfig() as unknown as coreRuntime.CoreProxyConfig | null) ?? null,
      }),
      RECOMMENDATION_TIMEOUT_MS,
      null
    )
  }

  /**
   * Silently refreshes the provider-scoped optimal-backend cache. Unlike
   * `recheckOptimalBackend`, this never writes the shared recommendation key
   * and never emits `onBetterBackendDetected`. `hardwareHasNoGpu` is the web
   * app's confirmed CPU-only fast path and travels as `assume_no_gpu`.
   */
  async refreshOptimalBackendCache(options?: {
    hardwareHasNoGpu?: boolean
  }): Promise<OptimalBackendCacheRecord | null> {
    if (IS_MAC) return null

    const epoch = this.optimalEpoch
    const result = await this.askCoreForRecommendation({
      mode: 'refresh',
      assume_no_gpu: options?.hardwareHasNoGpu === true,
    })
    if (!result || result.outcome === 'detection_failed') {
      throw new Error(BACKEND_DETECTION_FAILED)
    }
    if (epoch === this.optimalEpoch) {
      this.applyOptimalState({ revision: result.revision, optimal: result.optimal })
    }
    return result.record
  }

  /**
   * Why the last `recheckOptimalBackend()` returned null — `mac`,
   * `cpu_optimal`, `already_optimal`, `no_catalog_entry` or `threw`. Recorded
   * rather than returned so the method keeps its API. Read via
   * `getLastRecheckOutcome()`.
   */
  private lastRecheckOutcome: string | null = null

  /** See `lastRecheckOutcome`. */
  getLastRecheckOutcome(): string | null {
    return this.lastRecheckOutcome
  }

  /**
   * Manually re-runs hardware detection and returns a recommendation if a
   * better GPU backend than the current one is available ("Find optimal
   * backend"). The decision is the core's (`recommendation`, mode `recheck`).
   *
   * Side effects: writes `atomic_prism_better_backend_recommendation` and emits
   * `AppEvent.onBetterBackendDetected`, both carrying `provider: 'atomic-prism'`.
   * Throws `BACKEND_DETECTION_FAILED` when detection could not complete.
   */
  async recheckOptimalBackend(): Promise<BetterBackendPayload | null> {
    if (IS_MAC) {
      this.lastRecheckOutcome = 'mac'
      return null
    }
    this.lastRecheckOutcome = null
    try {
      logger.info('recheckOptimalBackend: asking the core for a recommendation')
      const epoch = this.optimalEpoch
      const result = await this.askCoreForRecommendation({ mode: 'recheck' })

      if (!result || result.outcome === 'detection_failed') {
        logger.warn(
          'recheckOptimalBackend: backend detection failed — keeping current backend (no silent CPU fallback)'
        )
        throw new Error(BACKEND_DETECTION_FAILED)
      }

      // The core has committed the record; mirror it unless the attachment
      // changed underneath this call.
      if (epoch === this.optimalEpoch) {
        this.applyOptimalState({ revision: result.revision, optimal: result.optimal })
      }

      if (result.outcome === 'recommend' && result.recommendation) {
        const payload: BetterBackendPayload = {
          ...result.recommendation,
          provider: this.providerId,
        }
        logger.info(
          `recheckOptimalBackend: surfacing recommendation ${payload.recommendedBackend} (${payload.recommendedCategory})`
        )
        localStorage.setItem(
          BETTER_BACKEND_RECOMMENDATION_KEY,
          JSON.stringify(payload)
        )
        if (events && typeof events.emit === 'function') {
          events.emit(AppEvent.onBetterBackendDetected, payload)
        }
        return payload
      }

      this.lastRecheckOutcome =
        result.outcome === 'recommend' ? 'no_catalog_entry' : result.outcome
      logger.info(`recheckOptimalBackend: no recommendation (${this.lastRecheckOutcome})`)
      localStorage.removeItem(BETTER_BACKEND_RECOMMENDATION_KEY)
      return null
    } catch (err) {
      // Propagate the detection-failure sentinel so callers can distinguish
      // it from "CPU is optimal"; anything else stays best-effort.
      if (err instanceof Error && err.message === BACKEND_DETECTION_FAILED) {
        throw err
      }
      logger.warn('recheckOptimalBackend failed:', err)
      this.lastRecheckOutcome = 'threw'
      return null
    }
  }

  /**
   * Whether a newer build of the current backend's type exists, as the core
   * judges it from the PrismML manifest. `sameFamily` is the core's verdict on
   * whether taking the target would change backend type; the callers refuse
   * when it is false. A missing or malformed `version_backend` is answered
   * locally as "no update" without asking.
   */
  async checkBackendForUpdates(options?: {
    force?: boolean
  }): Promise<BackendUpdateCheckResult> {
    const noUpdate = { updateNeeded: false, newVersion: '0', sameFamily: false }
    try {
      const currentBackend = stripBom(this.config.version_backend || '')
      if (!currentBackend || !currentBackend.includes('/')) {
        return noUpdate
      }

      const result = (await coreRuntime.checkBackendUpdates({
        current: currentBackend,
        force: options?.force ?? false,
        app_version: await appVersion(),
        proxy: (getProxyConfig() as unknown as coreRuntime.CoreProxyConfig | null) ?? null,
      })) as PrismBackendUpdateCheck
      const text = (value: unknown): string | undefined =>
        typeof value === 'string' && value ? value : undefined
      const withdrawn = result.current_withdrawn
      return {
        updateNeeded: result.update_needed,
        newVersion: result.new_version,
        targetBackend: result.target_backend ?? undefined,
        sameFamily: result.same_family,
        reason: text(result.reason),
        notesUrl: text(result.notes_url),
        notes: text(result.notes),
        downloadSize:
          typeof result.download_size === 'number' && result.download_size > 0
            ? result.download_size
            : undefined,
        currentWithdrawn:
          withdrawn && typeof withdrawn === 'object'
            ? (text(withdrawn.reason) ?? 'withdrawn')
            : undefined,
      }
    } catch (err) {
      logger.warn('checkBackendForUpdates failed:', err)
      return noUpdate
    }
  }

  /**
   * Manual engine-update check behind the "check for engine updates" button.
   * Forces the core to re-read the manifest, so a release published while the
   * app was open becomes visible. Only the decision happens here, and every
   * leg of it is bounded; the caller starts the download.
   */
  async checkForEngineUpdate(): Promise<{
    updateAvailable: boolean
    targetBackend: string | null
  }> {
    const noUpdate = { updateAvailable: false, targetBackend: null }

    // A configuration pass started at load may still be fetching the catalog.
    if (this.configureBackendsPromise) {
      await this.withTimeout(this.configureBackendsPromise, 20_000, undefined)
    }

    const current = stripBom(this.config.version_backend || '')
    const currentType = current.split('/')[1]?.trim()
    if (!current || current === 'none' || !currentType) return noUpdate

    const { updateNeeded, targetBackend, sameFamily } = await this.withTimeout(
      this.checkBackendForUpdates({ force: true }),
      20_000,
      { updateNeeded: false, newVersion: '0', sameFamily: false }
    )
    const targetType = targetBackend?.split('/')[1]?.trim()
    if (!updateNeeded || !targetBackend || !targetType) return noUpdate

    if (!sameFamily) {
      logger.warn(
        `checkForEngineUpdate: refusing to switch backend type ${currentType} -> ${targetType}`
      )
      return noUpdate
    }

    logger.info(`checkForEngineUpdate: ${current} -> ${targetBackend}`)
    return { updateAvailable: true, targetBackend }
  }

  async listInstalledBackends(): Promise<InstalledBackendPack[]> {
    const current = stripBom(this.config.version_backend || '')
    // The core owns the data folder, so it owns the answer: it may have installed a pack this
    // process never saw, and scanning the directory ourselves would race its staging move.
    return (await coreRuntime.listInstalledBackends(
      current
    )) as unknown as InstalledBackendPack[]
  }

  async deleteBackend(version: string, backend: string): Promise<void> {
    await coreRuntime.removeBackend(version, backend)
  }

  async getProviderPath(): Promise<string> {
    if (!this.providerPath) {
      this.providerPath = await joinPath([
        await getJanDataFolderPath(),
        this.providerId,
      ])
    }
    return this.providerPath
  }

  /**
   * Returns the SHARED models root of every llama.cpp provider:
   * `<jan>/llamacpp/models`. Backend binaries and provider config stay
   * isolated under `<jan>/atomic-prism/`.
   */
  async getModelsRootPath(): Promise<string> {
    return await joinPath([
      await getJanDataFolderPath(),
      MODELS_PROVIDER_ROOT,
      'models',
    ])
  }

  override async onUnload(): Promise<void> {
    this.unlistenValidationStarted?.()
    this.unlistenAutoIncreaseCtx?.()
    this.unlistenCoreSettingsChanged?.()
    this.unlistenCoreOptimalChanged?.()
    this.unlistenCoreSnapshot?.()
    this.unlistenCoreDetached?.()
  }

  onSettingUpdate<T>(key: string, value: T): void {
    if (this.isMirroringCoreSettings) {
      // `updateSettings` synchronously calls this hook for every persisted descriptor. A mirror
      // must refresh the app's copy and in-memory config, but must not start backend downloads
      // or other work of its own before the core revision is acknowledged.
      this.config[key] = value
      if (key === 'llamacpp_env') this.llamacpp_env = value as string
      if (key === 'timeout') this.timeout = value as number
      return
    }
    if (key === 'version_backend') {
      // Skip entirely if updateBackend() is already handling it —
      // updateBackend() will commit to in-memory config itself after all
      // side effects succeed.
      if (this.isUpdatingBackend) {
        return
      }
      // During initialization, configureBackends handles all backend
      // setup; any updateSettings calls (e.g. BOM cleanup) should only
      // touch in-memory config without triggering downloads.
      if (this.isInitializing || this.isConfiguringBackends) {
        if (typeof value === 'string') {
          this.config[key] = stripBom(value) as any
        } else {
          this.config[key] = value
        }
        return
      }
    }

    if (key === 'version_backend' && typeof value === 'string') {
      value = stripBom(value) as T
    }
    const previousVersionBackend =
      key === 'version_backend'
        ? stripBom(this.config.version_backend || '')
        : undefined
    // `updateSettings` reports every setting on each save, changed or not.
    const candidateBuildsChanged =
      key === 'allow_candidate_builds' &&
      !this.isInitializing &&
      this.config.allow_candidate_builds !== value
    this.config[key] = value
    if (candidateBuildsChanged) void this.applyCandidateBuildsChange()

    if (key === 'version_backend') {
      const valueStr = value as string
      // Async logic wrapped in IIFE since onSettingUpdate is void
      ;(async () => {
        try {
          if (valueStr.startsWith('latest/')) {
            const backendId = valueStr.slice('latest/'.length).trim()
            const resolved = await this.resolveLatestBackendString(backendId)
            if (!resolved) {
              logger.error(
                `Could not resolve the latest release for '${backendId}' — the PrismML catalog is unreachable. Backend left unchanged.`
              )
              this.config.version_backend = previousVersionBackend ?? ''
              return
            }
            await this.updateBackend(resolved)
            return
          }

          const result = parseVersionBackendSetting(
            valueStr,
            this.getStoredBackendType() || undefined
          )

          if (result.backend_type_updated && result.effective_backend_type) {
            this.setStoredBackendType(result.effective_backend_type)
            logger.info(
              `Updated backend type preference to: ${result.effective_backend_type}`
            )
          }

          if (result.version && result.backend) {
            this.config.device = ''
            await this.ensureBackendReady(result.backend, result.version)
          }
        } catch (e) {
          logger.error('Error in onSettingUpdate async block:', e)
        }
      })()
    } else if (key === 'llamacpp_env') {
      this.llamacpp_env = value as string
    } else if (key === 'timeout') {
      this.timeout = value as number
    }
  }

  /**
   * Resolves a `latest/<backend>` selection to the newest concrete
   * `<tag>/<backend>` the core's catalog lists for it. The catalog is re-read
   * (`force`) because "latest" is what the user asked for. Returns `null` when
   * the core is unreachable or no release carries that backend.
   */
  private async resolveLatestBackendString(
    backend: string
  ): Promise<string | null> {
    try {
      const remote = (
        await loadCatalog({ force: true, appVersion: await appVersion() })
      ).remote
      let best: { version: string; build: number } | null = null
      for (const entry of remote) {
        if (stripBom(entry.backend) !== backend) continue
        const build = prismTagBuild(entry.version) ?? -1
        if (!best || build > best.build) best = { version: stripBom(entry.version), build }
      }
      if (best) return `${best.version}/${backend}`
      logger.warn(
        `[resolveLatestBackendString] '${backend}' not found in the PrismML catalog`
      )
    } catch (err) {
      logger.warn(
        `[resolveLatestBackendString] Failed to read the catalog for '${backend}': ${coreRuntime.describeCoreError(err)}`
      )
    }
    return null
  }

  /**
   * Resolves `p`, but never waits longer than `ms`. On timeout — or if `p`
   * rejects — resolves to `fallback`, so a core that stopped answering can
   * never leave a spinner up forever.
   */
  private withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ])
  }

  /**
   * The newest installed release of `backendId` as `<tag>/<backend>`, or
   * `null` when none is installed — the offline fallback for a `latest/`
   * selection.
   */
  private async newestInstalledOfFamily(
    backendId: string
  ): Promise<string | null> {
    try {
      const sameType = (await getLocalInstalledBackends()).filter(
        (b) => stripBom(b.backend) === backendId
      )
      if (sameType.length === 0) return null
      sameType.sort(
        (a, b) => (prismTagBuild(b.version) ?? -1) - (prismTagBuild(a.version) ?? -1)
      )
      return `${stripBom(sameType[0].version)}/${stripBom(sameType[0].backend)}`
    } catch (err) {
      logger.warn(`newestInstalledOfFamily('${backendId}') failed:`, err)
      return null
    }
  }

  /**
   * Drives a manual backend selection through the same download → hot-swap →
   * completed dialog the "Find optimal backend" button uses. Accepts a concrete
   * `<tag>/<backend>` or a `latest/<backend>` sentinel, keyed on the selection
   * so the globally-mounted `<BackendUpdater />` dialog can follow it through
   * events alone. Throws (after `onManualBackendFailed`) when the target can
   * be neither resolved nor satisfied from a local install.
   */
  async downloadManualBackend(selection: string): Promise<void> {
    const sentinel = stripBom(selection)
    const isSentinel = sentinel.startsWith('latest/')
    const backendId = isSentinel
      ? sentinel.slice('latest/'.length).trim()
      : (sentinel.split('/')[1] || '').trim()
    const dialogKey = sentinel
    const label = friendlyBackendLabel(backendId)
    const current = stripBom(this.config.version_backend || '')

    // Open the dialog straight into its "downloading" spinner.
    if (events && typeof events.emit === 'function') {
      events.emit('onManualBackendDownloading', {
        currentBackend: current,
        recommendedBackend: dialogKey,
        recommendedCategory: label,
        provider: this.providerId,
        backendId,
      })
    }

    try {
      // The core bounds its own manifest read; this cap only guards against a
      // wedged promise and sits above the core's fetch budget.
      const MANUAL_RESOLVE_TIMEOUT_MS = 20000
      let concrete: string | null = null
      if (isSentinel) {
        concrete = await this.withTimeout(
          this.resolveLatestBackendString(backendId),
          MANUAL_RESOLVE_TIMEOUT_MS,
          null
        )
        if (!concrete) {
          concrete = await this.newestInstalledOfFamily(backendId)
          if (concrete) {
            logger.warn(
              `downloadManualBackend: catalog unreachable/slow for '${backendId}', falling back to newest installed ${concrete}`
            )
          }
        }
      } else {
        concrete = sentinel
      }

      if (!concrete) {
        throw new Error(
          `Could not download the ${label} backend: the PrismML release catalog is unreachable or slow, and no version of this backend is installed locally. Check your connection/proxy (Settings → Proxy) and try again, or install the backend from a downloaded archive via "Install backend from file".`
        )
      }

      // Download only if the resolved target isn't already on disk.
      const [tag, btype] = concrete.split('/')
      if (await isBackendInstalled(btype, tag)) {
        logger.info(
          `downloadManualBackend: ${concrete} already installed — switching without download`
        )
      } else {
        logger.info(`downloadManualBackend: downloading ${concrete}`)
        await this.downloadAndInstallBackend(concrete)
      }

      // Advance the dialog to "hot-swapping".
      if (events && typeof events.emit === 'function') {
        events.emit(AppEvent.onBackendDownloadFinished, {
          backend: dialogKey,
          status: 'completed',
          provider: this.providerId,
          backendId,
        })
      }

      await this.applyBackendLive(concrete)
      logger.info(`downloadManualBackend: applied ${concrete} live`)
    } catch (err) {
      logger.error('downloadManualBackend failed:', err)
      if (events && typeof events.emit === 'function') {
        events.emit('onManualBackendFailed', {
          backend: dialogKey,
          error: err instanceof Error ? err.message : String(err),
          provider: this.providerId,
          backendId,
        })
      }
      throw err
    }
  }

  /** A model of this provider; a model the core did not set up for PrismML is not one. */
  override async get(modelId: string): Promise<modelInfo | undefined> {
    const modelPath = await joinPath([await this.getModelsRootPath(), modelId])
    const path = await joinPath([modelPath, 'model.yml'])

    if (!(await fs.existsSync(path))) return undefined

    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path,
    })
    if (!coreRuntime.isPrismModel(modelConfig)) return undefined

    return {
      id: modelId,
      name: modelConfig.name ?? modelId,
      quant_type: undefined,
      providerId: this.provider,
      port: 0, // port is not known until the model is loaded
      sizeBytes: modelConfig.size_bytes ?? 0,
    } as modelInfo
  }

  /**
   * Whether a model's mmproj is a vision projector, cached in model.yml so
   * `list()` reads the projector GGUF once, not on every call.
   */
  private async resolveProjectorVision(
    modelId: string,
    modelConfig: ModelConfig
  ): Promise<boolean> {
    if (
      typeof modelConfig.projector_vision === 'boolean' &&
      typeof modelConfig.projector_audio === 'boolean'
    ) {
      return modelConfig.projector_vision
    }

    // An unreadable projector stays a vision projector rather than losing its capability.
    let kind = { vision: true, audio: false }
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const fullMmprojPath = await joinPath([
        janDataFolderPath,
        modelConfig.mmproj_path,
      ])
      if (await fs.existsSync(fullMmprojPath)) {
        const metadata = await readGgufMetadata(fullMmprojPath)
        kind = classifyProjector(metadata.metadata)
      }
    } catch (e) {
      logger.warn(`Failed to classify projector for ${modelId}`, e)
      return kind.vision
    }

    try {
      const configPath = await joinPath([
        await this.getModelsRootPath(),
        modelId,
        'model.yml',
      ])
      modelConfig.projector_vision = kind.vision
      modelConfig.projector_audio = kind.audio
      await invoke<void>('write_yaml', {
        data: modelConfig,
        savePath: configPath,
      })
    } catch (e) {
      logger.warn(`Failed to cache projector kind for ${modelId}`, e)
    }

    return kind.vision
  }

  /**
   * The models of this provider: only those whose `model.yml` the core marked
   * `atomic_runtime.provider: atomic-prism`. Every other model in the shared
   * tree belongs to the upstream / TurboQuant providers.
   */
  override async list(): Promise<modelInfo[]> {
    const modelsDir = await this.getModelsRootPath()
    if (!(await fs.existsSync(modelsDir))) {
      await fs.mkdir(modelsDir)
    }

    let modelIds: string[] = []

    // DFS
    let stack = [modelsDir]
    while (stack.length > 0) {
      const currentDir = stack.pop()

      // check if model.yml exists
      const modelConfigPath = await joinPath([currentDir, 'model.yml'])
      if (await fs.existsSync(modelConfigPath)) {
        // Normalize Windows '\' to '/' so the id matches the catalog
        modelIds.push(
          currentDir.slice(modelsDir.length + 1).replace(/\\/g, '/')
        )
        continue
      }

      // otherwise, look into subdirectories
      const children = await fs.readdirSync(currentDir)
      for (const child of children) {
        const childPath = await joinPath([currentDir, child])
        // skip files
        const dirInfo = await fs.fileStat(childPath)
        if (!dirInfo.isDirectory) {
          continue
        }

        stack.push(childPath)
      }
    }

    const janDataFolderPath = await getJanDataFolderPath()

    let modelInfos: modelInfo[] = []
    for (const modelId of modelIds) {
      const path = await joinPath([modelsDir, modelId, 'model.yml'])
      const modelConfig = await invoke<ModelConfig>('read_yaml', { path })
      if (!coreRuntime.isPrismModel(modelConfig)) continue

      const capabilities: string[] = []
      if (
        modelConfig.mmproj_path &&
        (await this.resolveProjectorVision(modelId, modelConfig))
      ) {
        capabilities.push('vision')
      }

      // Broken-link detection: flag a missing weights file so the UI marks it and auto-start skips it.
      const resolvedPath = await this.resolveModelPath(
        janDataFolderPath,
        modelConfig.model_path
      )
      const missing = resolvedPath
        ? !(await fs.existsSync(resolvedPath).catch(() => true))
        : false

      modelInfos.push({
        id: modelId,
        name: modelConfig.name ?? modelId,
        quant_type: undefined,
        providerId: this.provider,
        port: 0, // port is not known until the model is loaded
        sizeBytes: modelConfig.size_bytes ?? 0,
        capabilities: capabilities.length > 0 ? capabilities : undefined,
        source: (modelConfig as { source?: string }).source,
        missing,
        path: resolvedPath,
      } as modelInfo)
    }

    return modelInfos
  }

  // Resolve `model_path` (absolute or data-folder-relative) like `load()`; undefined if unknown.
  private async resolveModelPath(
    janDataFolderPath: string,
    modelPath?: string
  ): Promise<string | undefined> {
    if (!modelPath) return undefined
    try {
      return await joinPath([janDataFolderPath, modelPath])
    } catch {
      return undefined
    }
  }

  /**
   * Manually installs a PrismML backend archive from a local file
   * (`llama-prism-b10754-2459f68-bin-<backend>.(tar.gz|zip)`).
   *
   * Still unpacked by this process: the core has no route that installs a pack
   * from a local archive (its install route only downloads). The pack lands in
   * the same `atomic-prism/backends/<version>/<backend>` tree the core scans,
   * so the core picks it up on its next listing or load.
   */
  async installBackend(path: string): Promise<void> {
    const archiveName = await basename(path)
    logger.info(`Installing backend from path: ${path}`)

    if (
      !(await fs.existsSync(path)) ||
      (!path.endsWith('tar.gz') && !path.endsWith('zip'))
    ) {
      logger.error(`Invalid path or file ${path}`)
      throw new Error(`Invalid path or file ${path}`)
    }

    const parsed = parsePrismArchiveName(archiveName)
    if (!parsed) {
      throw new Error(
        `Failed to parse archive name: ${archiveName}. Expected format: llama-prism-b<build>-<commit>-bin-<backend>.(tar.gz|zip)`
      )
    }
    const { version, backend } = parsed
    logger.info(`Detected version: ${version}, backend: ${backend}`)

    const backendDir = await getBackendDir(backend, version)

    try {
      await invoke('decompress', { path: path, outputDir: backendDir })
      await invoke('normalize_backend_layout', {
        outputDir: backendDir,
        exeName: IS_WINDOWS ? 'llama-server.exe' : 'llama-server',
      })
    } catch (e) {
      logger.error(`Failed to install: ${String(e)}`)
      throw new Error(`Failed to extract backend archive: ${String(e)}`)
    }

    const binPath = await joinPath([
      backendDir,
      'build',
      'bin',
      IS_WINDOWS ? 'llama-server.exe' : 'llama-server',
    ])

    if (!(await fs.existsSync(binPath))) {
      await fs.rm(backendDir)
      throw new Error(
        'Not a supported backend archive! Missing llama-server binary.'
      )
    }

    const newBackendString = `${version}/${backend}`

    try {
      await this.configureBackends()

      // Auto-select the newly installed backend
      this.setStoredBackendType(backend)
      this.config.version_backend = newBackendString

      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (item.key === 'version_backend') {
            item.controllerProps.value = newBackendString
          }
          return item
        })
      )

      if (events && typeof events.emit === 'function') {
        events.emit('settingsChanged', {
          key: 'version_backend',
          value: newBackendString,
        })
      }

      logger.info(`Backend ${newBackendString} installed and auto-selected`)
    } catch (e) {
      logger.error('Backend installed but failed to refresh UI', e)
      throw new Error(
        `Backend installed but failed to refresh UI: ${String(e)}`
      )
    }
  }

  /**
   * Update a model with new information (a rename moves its folder). The rest
   * of `model.yml` — `atomic_runtime` included — travels unchanged.
   * @param modelId
   * @param model
   */
  async update(modelId: string, model: Partial<modelInfo>): Promise<void> {
    const modelFolderPath = await joinPath([
      await this.getModelsRootPath(),
      modelId,
    ])
    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: await joinPath([modelFolderPath, 'model.yml']),
    })
    const newFolderPath = await joinPath([
      await this.getModelsRootPath(),
      model.id,
    ])
    // Check if newFolderPath exists
    if (await fs.existsSync(newFolderPath)) {
      throw new Error(`Model with ID ${model.id} already exists`)
    }
    const newModelConfigPath = await joinPath([newFolderPath, 'model.yml'])
    await fs.mv(modelFolderPath, newFolderPath).then(() =>
      // now replace what values have previous model name with format
      invoke('write_yaml', {
        data: {
          ...modelConfig,
          model_path: modelConfig?.model_path?.replace(
            `${MODELS_PROVIDER_ROOT}/models/${modelId}`,
            `${MODELS_PROVIDER_ROOT}/models/${model.id}`
          ),
          mmproj_path: modelConfig?.mmproj_path?.replace(
            `${MODELS_PROVIDER_ROOT}/models/${modelId}`,
            `${MODELS_PROVIDER_ROOT}/models/${model.id}`
          ),
        },
        savePath: newModelConfigPath,
      })
    )
  }

  /**
   * Imports a model from a local file or a URL (through the download
   * extension) into the shared tree, marked `atomic_runtime.provider:
   * atomic-prism` so it lists under this provider and the core runs it on the
   * PrismML engine.
   */
  override async import(modelId: string, opts: ImportOptions): Promise<void> {
    const isValidModelId = (id: string) => {
      // only allow alphanumeric, underscore, hyphen, and dot characters in modelId
      if (!/^[a-zA-Z0-9/_\-\.]+$/.test(id)) return false

      // check for empty parts or path traversal
      const parts = id.split('/')
      return parts.every((s) => s !== '' && s !== '.' && s !== '..')
    }

    if (!isValidModelId(modelId))
      throw new Error(
        `Invalid modelId: ${modelId}. Only alphanumeric and / _ - . characters are allowed.`
      )

    // Origin of an externally-detected model (cast: optional field may lag the
    // built @janhq/core types until the package is rebuilt).
    const importSource = (opts as { source?: string }).source

    const configPath = await joinPath([
      await this.getModelsRootPath(),
      modelId,
      'model.yml',
    ])
    if (await fs.existsSync(configPath))
      throw new Error(`Model ${modelId} already exists`)

    // this is relative to Jan's data folder
    const modelDir = `${MODELS_PROVIDER_ROOT}/models/${modelId}`

    // we only use these from opts
    // opts.modelPath: URL to the model file
    // opts.mmprojPath: URL to the mmproj file

    let downloadItems: DownloadItem[] = []

    const maybeDownload = async (path: string, saveName: string) => {
      // if URL, add to downloadItems, and return local path
      if (isDownloadableUrl(path)) {
        const localPath = `${modelDir}/${saveName}`
        downloadItems.push({
          url: path,
          save_path: localPath,
          proxy: getProxyConfig(),
          sha256:
            saveName === 'model.gguf' ? opts.modelSha256 : opts.mmprojSha256,
          size: saveName === 'model.gguf' ? opts.modelSize : opts.mmprojSize,
          model_id: modelId,
        })
        return localPath
      }

      // if local file (absolute path), check if it exists
      // and return the path
      if (!(await fs.existsSync(path)))
        throw new Error(`File not found: ${path}`)
      return path
    }

    /**
     * A multi-part GGUF is only usable as a complete set: llama.cpp opens the
     * first shard and finds the rest by their published file names, so the
     * whole set is pulled, under those names. Per-file hash/size from `opts`
     * describe the single file that was picked and are left off.
     */
    const shardUrls = isDownloadableUrl(opts.modelPath)
      ? ggufShardSetPaths(opts.modelPath)
      : [opts.modelPath]
    const isSharded = shardUrls.length > 1

    let modelPath: string
    if (isSharded) {
      logger.info(
        `Model ${modelId} is published in ${shardUrls.length} parts; downloading the full set.`
      )
      const shardPaths: string[] = []
      for (const url of shardUrls) {
        const saveName = url.split('/').pop() ?? 'model.gguf'
        const localPath = `${modelDir}/${saveName}`
        downloadItems.push({
          url,
          save_path: localPath,
          proxy: getProxyConfig(),
          model_id: modelId,
        })
        shardPaths.push(localPath)
      }
      modelPath = shardPaths[0]
    } else {
      modelPath = await maybeDownload(opts.modelPath, 'model.gguf')
    }

    let mmprojPath = opts.mmprojPath
      ? await maybeDownload(opts.mmprojPath, 'mmproj.gguf')
      : undefined
    const resumeDownload = (opts as ImportOptions & { resume?: boolean }).resume

    if (downloadItems.length > 0) {
      try {
        // emit download update event on progress
        const onProgress = (transferred: number, total: number) => {
          events.emit(DownloadEvent.onFileDownloadUpdate, {
            modelId,
            percent: transferred / total,
            size: { transferred, total },
            downloadType: 'Model',
          })
        }
        const downloadManager = window.core.extensionManager.getByName(
          '@janhq/download-extension'
        )
        await downloadManager.downloadFiles(
          downloadItems,
          this.createDownloadTaskId(modelId),
          onProgress,
          resumeDownload ?? false,
          // The downloader's stages (connecting, retrying, stalled) reach the
          // row only through this; without it a dead connection read as a
          // live download with a frozen ETA.
          (stage: unknown) =>
            events.emit(DownloadEvent.onFileDownloadUpdate, {
              modelId,
              downloadType: 'Model',
              stage,
            })
        )

        // The downloadFiles function only returns successfully if all files downloaded AND validated
        events.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
          modelId,
          downloadType: 'Model',
        })
      } catch (error) {
        const errorMessage = formatLoadError(error)

        const isCancellationError =
          errorMessage.includes('Download cancelled') ||
          errorMessage.includes('Validation cancelled') ||
          errorMessage.includes('Hash computation cancelled') ||
          errorMessage.includes('cancelled') ||
          errorMessage.includes('aborted')

        const isValidationError =
          errorMessage.includes('Hash verification failed') ||
          errorMessage.includes('Size verification failed') ||
          errorMessage.includes('Failed to verify file')

        // Classify before logging: an `error` log becomes a Sentry event, and a
        // user pressing Cancel is not a crash.
        if (!isCancellationError) {
          logger.error('Error downloading model:', modelId, errorMessage)
        }

        if (isCancellationError) {
          logger.info('Download cancelled for model:', modelId)
          events.emit(DownloadEvent.onFileDownloadStopped, {
            modelId,
            downloadType: 'Model',
          })
        } else if (isValidationError) {
          logger.error(
            'Validation failed for model:',
            modelId,
            'Error:',
            errorMessage
          )

          // Cancel any other download tasks for this model
          try {
            await this.abortImport(modelId)
          } catch (cancelError) {
            logger.warn('Failed to cancel download task:', cancelError)
          }

          await this.cleanupFailedDownload(modelId, downloadItems)

          events.emit(DownloadEvent.onModelValidationFailed, {
            modelId,
            downloadType: 'Model',
            error: errorMessage,
            reason: 'validation_failed',
          })
        } else {
          events.emit(DownloadEvent.onFileDownloadError, {
            modelId,
            downloadType: 'Model',
            error: errorMessage,
          })
        }
        throw error
      }
    }

    // Validate GGUF files. Only the header and key/value metadata are read, so
    // PrismML-only tensor types do not trip it.
    const janDataFolderPath = await getJanDataFolderPath()
    const fullModelPath = await joinPath([janDataFolderPath, modelPath])

    try {
      const modelMetadata = await readGgufMetadata(fullModelPath)
      logger.info(
        `Model GGUF validation successful: version ${modelMetadata.version}, tensors: ${modelMetadata.tensor_count}`
      )

      if (mmprojPath) {
        const fullMmprojPath = await joinPath([janDataFolderPath, mmprojPath])
        const mmprojMetadata = await readGgufMetadata(fullMmprojPath)
        logger.info(
          `Mmproj GGUF validation successful: version ${mmprojMetadata.version}, tensors: ${mmprojMetadata.tensor_count}`
        )
      }
    } catch (error) {
      logger.error('GGUF validation failed:', error)
      throw new Error(
        `Invalid GGUF file(s): ${
          error.message || 'File format validation failed'
        }`
      )
    }

    // A Tauri command rejects with a bare string, so the step that failed and
    // the path it failed on are both lost by the time the toast renders (issue
    // #256). Name each step on the way out.
    const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run()
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : String(error ?? 'unknown')
        logger.error(`import(${modelId}): ${what} failed: ${reason}`)
        throw new Error(`${what} failed: ${reason}`)
      }
    }

    // Calculate file sizes. A sharded model is the sum of its parts.
    let size_bytes = 0
    for (const shard of ggufShardSetPaths(fullModelPath)) {
      size_bytes += (await step(`reading ${shard}`, () => fs.fileStat(shard)))
        .size
    }
    if (mmprojPath) {
      const fullMmprojPath = await joinPath([janDataFolderPath, mmprojPath])
      size_bytes += (
        await step(`reading ${fullMmprojPath}`, () =>
          fs.fileStat(fullMmprojPath)
        )
      ).size
    }

    const modelConfig = {
      model_path: modelPath,
      mmproj_path: mmprojPath,
      name: modelId,
      size_bytes,
      // `model_sha256` / `model_size_bytes` are per-file expectations checked
      // against `model_path` at load, so they are only recorded for
      // single-file models.
      ...(isSharded
        ? {}
        : {
            model_sha256: opts.modelSha256,
            model_size_bytes: opts.modelSize,
          }),
      mmproj_sha256: opts.mmprojSha256,
      mmproj_size_bytes: opts.mmprojSize,
      ...(importSource ? { source: importSource } : {}),
      atomic_runtime: { ...PRISM_ATOMIC_RUNTIME },
    } as ModelConfig & { atomic_runtime: { provider: 'atomic-prism' } }
    const fullModelDir = await joinPath([janDataFolderPath, modelDir])
    await step(`creating ${fullModelDir}`, () => fs.mkdir(fullModelDir))
    await step(`writing ${configPath}`, () =>
      invoke<void>('write_yaml', {
        data: modelConfig,
        savePath: configPath,
      })
    )
    events.emit(AppEvent.onModelImported, {
      modelId,
      // Every llama.cpp provider lists the same GGUF dir, so the web-app
      // cannot tell from `modelId` alone which engine imported the file.
      provider: this.provider,
      modelPath,
      mmprojPath,
      size_bytes,
      model_sha256: opts.modelSha256,
      model_size_bytes: opts.modelSize,
      mmproj_sha256: opts.mmprojSha256,
      mmproj_size_bytes: opts.mmprojSize,
      source: importSource,
    })
  }

  /**
   * Remove what a failed download left behind — and nothing else. The model
   * directory is shared between the llama.cpp providers, so only the artifacts
   * of *this* download are removed (the target file plus its `.tmp` / `.url` /
   * `.parts` partials), and the directory itself goes only when nothing else
   * is left in it.
   */
  private async cleanupFailedDownload(
    modelId: string,
    items: DownloadItem[]
  ): Promise<void> {
    try {
      const janDataFolderPath = await getJanDataFolderPath()

      for (const item of items) {
        for (const suffix of ['', '.tmp', '.url', '.parts']) {
          const path = await joinPath([
            janDataFolderPath,
            `${item.save_path}${suffix}`,
          ])
          if (await fs.existsSync(path)) {
            logger.warn(
              `Removing artifact of the failed download of ${modelId}: ${path}`
            )
            await fs.rm(path)
          }
        }
      }

      const modelDir = await joinPath([await this.getModelsRootPath(), modelId])
      if (!(await fs.existsSync(modelDir))) return

      const remaining = (await fs.readdirSync(modelDir)) as string[]
      if (remaining.length === 0) {
        logger.info(`Removing empty model directory: ${modelDir}`)
        await fs.rm(modelDir)
      } else {
        logger.warn(
          `Keeping ${modelDir}: ${remaining.length} file(s) there did not belong to this download (${remaining.join(', ')})`
        )
      }
    } catch (deleteError) {
      logger.warn('Failed to clean up after a failed download:', deleteError)
    }
  }

  override async abortImport(modelId: string): Promise<void> {
    // prepend provider name to avoid name collision
    const taskId = this.createDownloadTaskId(modelId)
    const downloadManager = window.core.extensionManager.getByName(
      '@janhq/download-extension'
    )

    try {
      await downloadManager.cancelDownload(taskId)
    } catch (cancelError) {
      logger.warn('Failed to cancel download task:', cancelError)
    }
  }

  /**
   * Load a model in the core.
   *
   * The core resolves its own backend, applies its own settings and owns the process. This
   * engine has no embedding mode, so a load is always a chat load.
   */
  override async load(
    modelId: string,
    overrideSettings?: Partial<PrismConfig>,
    _isEmbedding: boolean = false,
    bypassAutoUnload: boolean = false,
    options?: ModelLoadOptions
  ): Promise<SessionInfo> {
    return this.loadCancel.track(modelId, async () => {
      try {
        await this.ensureCoreIsReady()
        this.loadCancel.throwIfCancelled(modelId)
        // ATO-530: a missing engine build is downloaded by the core before
        // anything else can happen, and that wait is worth naming.
        if (options?.onStage && !(await this.isConfiguredBackendInstalled())) {
          options.onStage({ kind: 'installingEngine' })
        }
        this.loadCancel.throwIfCancelled(modelId)
        if (options?.onStage) {
          options.onStage({
            kind: 'loadingWeights',
            cachedFraction: await this.pageCacheFraction(
              await this.modelFilePaths(modelId)
            ),
          })
        }
        return await this.loadCancel.loadInCore(modelId, () =>
          coreRuntime.load(modelId, {
            ...(overrideSettings
              ? { settings: overrideSettings as Record<string, unknown> }
              : {}),
            isEmbedding: false,
            bypassAutoUnload,
          })
        )
      } catch (error) {
        throw toLoadError(error)
      }
    })
  }

  /**
   * ATO-530: stop a load of `modelId` that has not finished. Resolves `true`
   * when one was running; that load then rejects with MODEL_LOAD_CANCELLED
   * and leaves no server behind.
   */
  override cancelLoad(modelId: string): Promise<boolean> {
    return this.loadCancel.cancelLoad(modelId)
  }

  /// Whether the configured `<version>/<backend>` is on disk; anything unsure
  /// counts as installed, so the stage is never announced by mistake.
  private async isConfiguredBackendInstalled(): Promise<boolean> {
    const versionBackend = stripBom(this.config?.version_backend || '')
    const [version, backend] = versionBackend.split('/')
    if (!version || !backend) return true
    try {
      return await isBackendInstalled(stripBom(backend), stripBom(version))
    } catch {
      return true
    }
  }

  /// The weights files of a model, for the page-cache probe; empty when unknown.
  private async modelFilePaths(modelId: string): Promise<string[]> {
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const path = await joinPath([
        janDataFolderPath,
        MODELS_PROVIDER_ROOT,
        'models',
        modelId,
        'model.yml',
      ])
      const config = await invoke<ModelConfig>('read_yaml', { path })
      const paths: string[] = []
      for (const file of [config.model_path, config.mmproj_path]) {
        const resolved = await this.resolveModelPath(janDataFolderPath, file)
        if (resolved) paths.push(resolved)
      }
      return paths
    } catch {
      return []
    }
  }

  /**
   * How much of `paths` the OS already holds in its page cache (0–1), or
   * `null` when that cannot be told. Only ever feeds the loading status, so a
   * failure is not worth more than a debug line.
   */
  private async pageCacheFraction(paths: string[]): Promise<number | null> {
    if (paths.length === 0) return null
    try {
      const fraction = await invoke<number | null>(
        'get_page_cache_resident_fraction',
        { paths }
      )
      return typeof fraction === 'number' ? fraction : null
    } catch (error) {
      console.debug(`page cache probe failed: ${error}`)
      return null
    }
  }

  /// Public lookup used by the web-app UI (via duck-typed engine call) so
  /// the in-app "Increase Context" path can clamp at the model's true
  /// training-max ctx. Asked of the core, which reads it from the GGUF
  /// without loading the model, and cached for the lifetime of the extension.
  async getMaxCtxTrain(modelId: string): Promise<number | undefined> {
    const cached = this.modelMaxCtxTrain.get(modelId)
    if (typeof cached === 'number') return cached
    try {
      const caps = await coreRuntime.capabilities(modelId)
      if (typeof caps.maxCtxTrain === 'number') {
        this.modelMaxCtxTrain.set(modelId, caps.maxCtxTrain)
        return caps.maxCtxTrain
      }
      return undefined
    } catch (error) {
      logger.warn(
        `[atomic-core] could not read capabilities for ${modelId}: ${coreRuntime.describeCoreError(error)}`
      )
      return undefined
    }
  }

  /// Bridge from the Local API Server proxy (Rust) back to the extension
  /// when a forwarded request exhausts the model's context window, or when a
  /// fatal compute error poisons the engine. The core owns the process and the
  /// context ladder, so this asks it to act, answers the proxy on a
  /// request-scoped done event, and notifies the web-app UI so the provider
  /// store mirrors the new value.
  private async handleAutoIncreaseCtx(
    payload: AutoIncreaseCtxRequest
  ): Promise<void> {
    const { request_id, model_id, trigger } = payload
    const doneChannel = `${AUTO_INCREASE_CTX_DONE_PREFIX}${request_id}`

    const sendDone = async (body: {
      ok: boolean
      new_ctx_len?: number
      reason?: string
    }) => {
      try {
        await tauriEmit(doneChannel, body)
      } catch (e) {
        logger.warn(
          `Failed to emit auto_increase_ctx_done (${doneChannel}): ${e}`
        )
      }
    }

    try {
      // ATO-197: the proxy asks us to recreate a poisoned backend after a
      // fatal Metal/compute error (e.g. a GPU OOM during prompt processing).
      // The model restarts at the context it already has — growing it would
      // only make an OOM worse — and the ctx-grow UI notify is not emitted.
      if (trigger === COMPUTE_ERROR_RECOVERY_TRIGGER) {
        const outcome = await coreRuntime.recreateSession(model_id)
        await sendDone(outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason })
        logger.info(
          `compute_error_recovery (core): recreate model=${model_id} ok=${outcome.ok}`
        )
        return
      }

      // With fit on, the context is what llama.cpp found room for at load.
      // Reloading with a bigger `ctx_size` would be dropped by the argument
      // builder (`--ctx-size` is not emitted under fit) and fit would size it
      // again — a reload that changes nothing. The ladder is fit-off only.
      if (this.config?.fit === true) {
        await sendDone({ ok: false, reason: 'fit' })
        logger.info(
          `auto_increase_ctx: fit is on for ${model_id}; the engine sizes the context itself`
        )
        return
      }

      const outcome = await coreRuntime.increaseContext(model_id, trigger)
      if (outcome.ok === false) {
        const declined = outcome as Extract<coreRuntime.CoreCtxIncrease, { ok: false }>
        await sendDone({ ok: false, reason: declined.reason })
        if (declined.reason === 'at_max') {
          // The web-app shows a one-shot toast on this and stops driving
          // further regeneration attempts.
          const currentCtxLen = declined.current_ctx_len
          try {
            await tauriEmit(AUTO_INCREASE_CTX_AT_MAX, {
              provider: this.provider,
              modelId: model_id,
              maxCtxLen: declined.max_ctx_len ?? currentCtxLen,
              currentCtxLen,
            })
          } catch (e) {
            logger.warn(`Failed to Tauri-emit ${AUTO_INCREASE_CTX_AT_MAX}: ${e}`)
          }
        }
        logger.info(
          `auto_increase_ctx (core) declined model=${model_id} reason=${declined.reason}`
        )
        return
      }

      const newCtxLen = outcome.new_ctx_len
      const notifyPayload = {
        provider: this.provider,
        modelId: model_id,
        newCtxLen,
      }
      if (events && typeof events.emit === 'function') {
        events.emit(ModelEvent.OnAutoIncreasedCtxLen, notifyPayload)
      }
      // Redundant Tauri-level broadcast so the web-app can listen on the
      // native event bus without depending on `@janhq/core`'s in-process
      // EventEmitter singleton.
      try {
        await tauriEmit(AUTO_INCREASE_CTX_NOTIFY, notifyPayload)
      } catch (e) {
        logger.warn(`Failed to Tauri-emit ${AUTO_INCREASE_CTX_NOTIFY}: ${e}`)
      }
      await sendDone({ ok: true, new_ctx_len: newCtxLen })
      logger.info(
        `auto_increase_ctx (core) model=${model_id} trigger=${trigger} newCtxLen=${newCtxLen}; notified UI via events + tauri`
      )
    } catch (e) {
      logger.error(
        `auto_increase_ctx handler failed for ${payload.model_id}: ${e}`
      )
      await sendDone({ ok: false, reason: `exception: ${e}` })
    }
  }

  /** The core owns the process, so it does the killing: this extension has no handle on it. */
  override async unload(modelId: string): Promise<UnloadResult> {
    try {
      return await coreRuntime.unload(modelId)
    } catch (error) {
      return {
        success: false,
        error: `Failed to unload model: ${coreRuntime.describeCoreError(error)}`,
      }
    }
  }

  private createDownloadTaskId(modelId: string) {
    // Prepend provider to make taskId unique across providers. Do NOT truncate
    // at the first '.' — model ids frequently contain one early in the name.
    // The taskId is embedded in a Tauri event name (`download-${taskId}`), and
    // Tauri rejects any character outside [A-Za-z0-9_/:-], so those are mapped
    // to '_' while keeping the full id.
    return `${this.provider}/${modelId.replace(/[^A-Za-z0-9_/:-]/g, '_')}`
  }

  /**
   * Sanitize a taskId part so the download-extension's `download-${taskId}`
   * listener is not rejected by Tauri's event-name validator
   * (`[A-Za-z0-9_/:-]`). Backend ids carry dots (`linux-cuda-12.4-x64`).
   */
  private sanitizeForTauriEvent(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, '_')
  }

  /**
   * Ensure the requested `version`/`backend` pack is installed, asking the core
   * to download it when it is not. Returns the pair that is now installed.
   *
   * Strict on purpose: every caller is an explicit backend selection, and a
   * deliberate choice is never silently swapped for another build.
   */
  private async ensureBackendReady(
    backend: string,
    version: string
  ): Promise<{ version: string; backend: string }> {
    backend = stripBom(backend)
    version = stripBom(version)
    const backendKey = `${version}/${backend}`
    if (await isBackendInstalled(backend, version)) {
      return { version, backend }
    }

    logger.info(
      `Backend ${backendKey} not installed locally, asking the core to download it...`
    )
    try {
      await this.downloadAndInstallBackend(backendKey)
    } catch (err) {
      const context = `Failed to download backend ${backendKey}:`
      if (
        (err as { code?: string } | undefined)?.code ===
        ERR_BACKEND_TAG_UNRESOLVED
      ) {
        logger.warn(`${context}\n${formatLoadError(err)}`)
      } else {
        logger.error(context, err)
      }
    }

    if (await isBackendInstalled(backend, version)) {
      return { version, backend }
    }

    throw new Error(
      `Backend ${backendKey} could not be downloaded — the PrismML release ` +
        `may be unreachable or has no build for your platform. Check your ` +
        `internet connection (Settings → Proxy) and try again later.`
    )
  }

  /**
   * Downloads a backend pack through the core, which fetches it from the
   * signed mirror and unpacks it into the data folder it owns — together with
   * the cudart companion a Windows CUDA build needs.
   *
   * The progress bar and the backend-updater dialog keep listening on the
   * events they always did; this method translates the core's progress into
   * them.
   */
  private async downloadAndInstallBackend(
    backendString: string
  ): Promise<void> {
    backendString = stripBom(backendString)
    const parts = backendString.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid backend string: ${backendString}`)
    }
    const [version, backend] = [stripBom(parts[0]), stripBom(parts[1])]

    // Defense-in-depth (ATO-95): a `latest` tag is an unresolved sentinel.
    if (version === 'latest') {
      throw codedLoadError(
        ERR_BACKEND_TAG_UNRESOLVED,
        `downloadAndInstallBackend: refusing to download unresolved 'latest' tag for '${backend}'. Resolve the latest/<backend> sentinel to a concrete release tag first.`
      )
    }

    if (await isBackendInstalled(backend, version)) {
      logger.info(
        `Backend ${backendString} is already installed, skipping download`
      )
      return
    }

    // The task id keeps the shape the progress bar has always listened on. The
    // `llamacpp-backend-` prefix routes the UI's cancel button to
    // `cancelDownload(taskId)` instead of the model-abort path.
    const taskId = `llamacpp-backend-${this.sanitizeForTauriEvent(
      version
    )}/${this.sanitizeForTauriEvent(backend)}`
    logger.info(`downloadAndInstallBackend: handing ${backendString} to the core (${taskId})`)
    let highestTransferred = 0
    let knownTotal = 0
    let completedProgress = false
    let reported = false
    const reportProgress = (transferred: number, total: number) => {
      reported = true
      // A resumed transfer can restart at byte zero after a range mismatch. The UI represents
      // task completion, so it must never move its bar backwards during that retry.
      highestTransferred = Math.max(highestTransferred, transferred)
      knownTotal = Math.max(knownTotal, total)
      const displayedTotal = knownTotal > 0 ? Math.max(knownTotal, highestTransferred) : 0
      completedProgress = displayedTotal > 0 && highestTransferred >= displayedTotal
      events.emit(DownloadEvent.onFileDownloadUpdate, {
        modelId: taskId,
        percent: displayedTotal > 0 ? highestTransferred / displayedTotal : 0,
        size: { transferred: highestTransferred, total: displayedTotal },
        downloadType: 'Backend',
      })
    }
    // Register before starting the transfer: the core can emit its first progress frame before
    // the POST returns. A frame with `stage` goes to the row's status, never through
    // `reportProgress`; a first 0/0 progress update names the row after the task id.
    const unlisten = await listen<{
      transferred: number
      total: number
      stage?: { kind: 'connecting' | 'retrying'; attempt: number; maxAttempts: number }
    }>(`download-${taskId}`, (event) => {
      const { stage } = event.payload
      if (stage) {
        if (!reported) reportProgress(0, 0)
        events.emit(DownloadEvent.onFileDownloadUpdate, { modelId: taskId, downloadType: 'Backend', stage })
        return
      }
      reportProgress(event.payload.transferred, event.payload.total)
    })
    events.emit(AppEvent.onBackendDownloadStarted, {
      backend: backendString,
      status: 'downloading',
      provider: this.providerId,
      version,
      backendId: backend,
    })
    try {
      await coreRuntime.installBackend(
        version,
        backend,
        taskId,
        false,
        getProxyConfig() as unknown as coreRuntime.CoreProxyConfig | null
      )
      if (!completedProgress && (knownTotal > 0 || highestTransferred > 0)) {
        reportProgress(Math.max(knownTotal, highestTransferred), Math.max(knownTotal, highestTransferred))
      }
      events.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
        modelId: taskId,
        downloadType: 'Backend',
      })
      events.emit(AppEvent.onBackendDownloadFinished, {
        backend: backendString,
        status: 'completed',
        provider: this.providerId,
        version,
        backendId: backend,
      })
    } catch (error) {
      const message = coreRuntime.describeCoreError(error)
      events.emit(DownloadEvent.onFileDownloadError, {
        modelId: taskId,
        error: message,
        downloadType: 'Backend',
      })
      events.emit(AppEvent.onBackendDownloadFinished, {
        backend: backendString,
        status: 'failed',
        error: message,
        provider: this.providerId,
        version,
        backendId: backend,
      })
      throw new Error(message)
    } finally {
      unlisten()
    }
  }

  private async *handleStreamingResponse(
    url: string,
    headers: HeadersInit,
    body: string,
    abortController?: AbortController
  ): AsyncIterable<chatCompletionChunk> {
    // Stream via Tauri IPC Channel instead of the intercepted global fetch:
    // tauri_plugin_http's ReadableStream bridge may not relay SSE chunks back
    // to the webview.
    const rawChunks: string[] = []
    let streamDone = false
    let streamError: Error | null = null
    let wakeUp: (() => void) | null = null

    const channel = new Channel<{ data: string; done?: boolean }>()
    channel.onmessage = (event: { data: string; done?: boolean }) => {
      if (event.data) rawChunks.push(event.data)
      // The end of the stream travels on the channel, after the last chunk and in
      // order with it. The command's return takes another route to the webview and
      // can overtake chunks still on their way; taken for the end, it closed a short
      // reply before any of it had arrived.
      if (event.done) streamDone = true
      if (wakeUp) {
        wakeUp()
        wakeUp = null
      }
    }

    const headersRecord: Record<string, string> = {}
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        headersRecord[k] = String(v)
      }
    }

    const timeoutNum = Number(this.timeout) || 1800

    const requestPromise = invoke<number>('stream_local_http', {
      url,
      headers: headersRecord,
      body,
      timeoutSecs: timeoutNum,
      onChunk: channel,
    })

    requestPromise
      .then(() => {
        // Only a fallback, for a stream whose `done` message never comes.
        setTimeout(() => {
          streamDone = true
          if (wakeUp) {
            wakeUp()
            wakeUp = null
          }
        }, 2_000)
      })
      .catch((e) => {
        logger.error('[stream] invoke rejected:', String(e))
        streamError = new Error(String(e))
        streamDone = true
        if (wakeUp) {
          wakeUp()
          wakeUp = null
        }
      })

    if (abortController?.signal) {
      const onAbort = () => {
        streamError = streamError ?? new Error('Request aborted')
        streamDone = true
        if (wakeUp) {
          wakeUp()
          wakeUp = null
        }
      }
      if (abortController.signal.aborted) {
        onAbort()
      } else {
        abortController.signal.addEventListener('abort', onAbort, {
          once: true,
        })
      }
    }

    let buffer = ''

    while (true) {
      while (rawChunks.length === 0 && !streamDone) {
        await new Promise<void>((resolve) => {
          wakeUp = resolve
        })
      }

      while (rawChunks.length > 0) {
        buffer += rawChunks.shift()!
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmedLine = line.trim()
          if (!trimmedLine || trimmedLine === 'data: [DONE]') {
            continue
          }

          let jsonStr = ''
          if (trimmedLine.startsWith('data: ')) {
            jsonStr = trimmedLine.slice(6)
          } else if (trimmedLine.startsWith('error: ')) {
            jsonStr = trimmedLine.slice(7)
            const error = JSON.parse(jsonStr)
            throw new Error(error.message)
          } else {
            throw new Error('Malformed chunk')
          }
          try {
            const data = JSON.parse(jsonStr)
            const chunk = data as chatCompletionChunk

            if (chunk.choices?.[0]?.finish_reason === 'length') {
              throw new Error(OUT_OF_CONTEXT_SIZE)
            }

            yield chunk
          } catch (e) {
            logger.error('Error parsing JSON from stream or server error:', e)
            throw e
          }
        }
      }

      if (streamDone) {
        if (streamError) throw streamError
        break
      }
    }
  }

  /// Which device the loaded model actually ran on, parsed from the
  /// llama-server startup log by the core and carried on its session. Feeds
  /// `model_load` telemetry. Never throws: telemetry must not break a load.
  async getRuntimeDeviceInfo(
    modelId: string
  ): Promise<RuntimeDeviceInfo | null> {
    try {
      const session = await coreRuntime.findSession(modelId)
      return (session?.runtime_device as RuntimeDeviceInfo | null | undefined) ?? null
    } catch (e) {
      logger.warn('getRuntimeDeviceInfo failed (continuing):', e)
      return null
    }
  }

  /**
   * Everything that must be true before the core loads its first model for us: the app's
   * settings for this provider are imported (once per attachment and settings generation),
   * because until they are, this app's copy is the truth and the core would load with its own
   * defaults instead of the user's. A conflict blocks the load.
   */
  private async ensureCoreIsReady(): Promise<void> {
    await this.coreSettings.ensureReady()
  }

  /**
   * Where a model is served, asked of the core every time: the core reloads a model on its own
   * when a prompt overflows the context window, and the port changes without this extension
   * being asked.
   */
  private async resolveSession(
    modelId: string
  ): Promise<SessionInfo | undefined> {
    return coreRuntime.findSession(modelId)
  }

  override async chat(
    opts: chatCompletionRequest,
    abortController?: AbortController
  ): Promise<chatCompletion | AsyncIterable<chatCompletionChunk>> {
    const sessionInfo = await this.resolveSession(opts.model)
    if (!sessionInfo) {
      throw new Error(`No active session found for model: ${opts.model}`)
    }
    // Liveness. The process lives in the core, so its pid means nothing here; the port answering
    // `/health` is the honest test — and the only one available across a process boundary.
    try {
      await globalThis.fetch(`http://localhost:${sessionInfo.port}/health`)
    } catch (e) {
      this.unload(sessionInfo.model_id)
      throw new Error('Model appears to have crashed! Please reload!')
    }
    const baseUrl = `http://localhost:${sessionInfo.port}/v1`
    const url = `${baseUrl}/chat/completions`
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionInfo.api_key}`,
    }
    // always enable prompt progress return if stream is true
    opts.return_progress = true

    const body = JSON.stringify(opts)
    if (opts.stream) {
      return this.handleStreamingResponse(url, headers, body, abortController)
    }
    // Handle non-streaming response – use globalThis.fetch to bypass
    // tauri_plugin_http whose ReadableStream bridge may hang on response body.
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abortController?.signal,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => null)
      throw new Error(
        `API request failed with status ${response.status}: ${JSON.stringify(
          errorData
        )}`
      )
    }

    const completionResponse = (await response.json()) as chatCompletion

    // finish_reason 'length' indicates context limit was hit
    if (completionResponse.choices?.[0]?.finish_reason === 'length') {
      throw new Error(OUT_OF_CONTEXT_SIZE)
    }

    return completionResponse
  }

  override async delete(modelId: string): Promise<void> {
    const modelDir = await joinPath([await this.getModelsRootPath(), modelId])

    if (!(await fs.existsSync(await joinPath([modelDir, 'model.yml'])))) {
      throw new Error(`Model ${modelId} does not exist`)
    }

    await fs.rm(modelDir)
  }

  override async getLoadedModels(): Promise<string[]> {
    try {
      return await coreRuntime.getLoadedModels()
    } catch (e) {
      logger.error(e)
      throw new Error(e)
    }
  }

  /**
   * Check if mmproj.gguf file exists for a given model ID
   * @param modelId - The model ID to check for mmproj.gguf
   * @returns Promise<boolean> - true if mmproj.gguf exists, false otherwise
   */
  async checkMmprojExists(modelId: string): Promise<boolean> {
    try {
      return (await coreRuntime.capabilities(modelId)).mmprojExists
    } catch {
      return false
    }
  }

  /**
   * Devices the installed backend reports. The core resolves its own backend and asks it; with
   * none installed it answers an empty list rather than an error.
   */
  async getDevices(): Promise<DeviceList[]> {
    try {
      return await coreRuntime.devices<DeviceList>()
    } catch (error) {
      logger.warn(
        `[atomic-core] could not list devices: ${coreRuntime.describeCoreError(error)}`
      )
      return []
    }
  }

  /**
   * Check if a tool is supported by the model
   * Currently read from GGUF chat_template
   * @param modelId
   * @returns
   */
  async isToolSupported(modelId: string): Promise<boolean> {
    const janDataFolderPath = await getJanDataFolderPath()
    const modelConfigPath = await joinPath([
      await this.getModelsRootPath(),
      modelId,
      'model.yml',
    ])
    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: modelConfigPath,
    })
    // NOTE: model_path and mmproj_path can be either relative to Jan's data folder or absolute path
    const modelPath = await joinPath([
      janDataFolderPath,
      modelConfig.model_path,
    ])
    return (await readGgufMetadata(modelPath)).metadata?.[
      'tokenizer.chat_template'
    ]?.includes('tools')
  }

  /**
   * Report the reasoning controls declared by the model's GGUF chat template.
   * @param modelId
   * @returns
   */
  async getReasoningControls(modelId: string): Promise<ReasoningControls> {
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const modelConfigPath = await joinPath([
        await this.getModelsRootPath(),
        modelId,
        'model.yml',
      ])
      const modelConfig = await invoke<ModelConfig>('read_yaml', {
        path: modelConfigPath,
      })
      const modelPath = await joinPath([
        janDataFolderPath,
        modelConfig.model_path,
      ])
      const metadata = await readGgufMetadata(modelPath)
      return detectReasoningControls(
        metadata.metadata?.['tokenizer.chat_template']
      )
    } catch (e) {
      logger.warn(`Failed to detect reasoning controls for ${modelId}: ${e}`)
      return { supportsThinking: false }
    }
  }

  /**
   * Check the support status of a model by its path (local/remote)
   *
   * Returns:
   * - "RED"    → weights don't fit in total memory
   * - "YELLOW" → weights fit in VRAM but need system RAM, or KV cache doesn't fit
   * - "GREEN"  → both weights + KV cache fit in VRAM
   */
  async isModelSupported(
    path: string,
    ctxSize?: number
  ): Promise<'RED' | 'YELLOW' | 'GREEN'> {
    try {
      // The cache types this engine loads with: the estimate used to assume
      // fp16 and went red on models a quantised cache fits comfortably.
      return await isModelSupported(
        path,
        Number(ctxSize),
        this.config.cache_type_k,
        this.config.cache_type_v
      )
    } catch (e) {
      throw new Error(String(e))
    }
  }

  /**
   * Validate GGUF file and check for unsupported architectures like CLIP
   */
  async validateGgufFile(filePath: string): Promise<{
    isValid: boolean
    error?: string
    metadata?: any
  }> {
    // The file lives in the data folder the core owns, and the core already refuses a CLIP
    // projector by name — the one rejection that matters, because those parse perfectly.
    try {
      return await coreRuntime.validateGguf(filePath)
    } catch (error) {
      return { isValid: false, error: coreRuntime.describeCoreError(error) }
    }
  }

  private sanitizeMessagesForApplyTemplate(
    messages: chatCompletionRequestMessage[]
  ): chatCompletionRequestMessage[] {
    return messages.filter((msg) => {
      if (!msg?.role) return false
      if (typeof msg.content === 'string') {
        return msg.content.trim().length > 0
      }
      if (Array.isArray(msg.content)) {
        return msg.content.length > 0
      }
      return false
    })
  }

  async getTokensCount(opts: chatCompletionRequest): Promise<number> {
    if (!opts.messages || opts.messages.length === 0) {
      return 0
    }

    const messagesForTemplate = this.sanitizeMessagesForApplyTemplate(
      opts.messages
    )
    if (messagesForTemplate.length === 0) {
      return 0
    }

    const sessionInfo = await this.resolveSession(opts.model)
    if (!sessionInfo) {
      throw new Error(`No active session found for model: ${opts.model}`)
    }

    const baseUrl = `http://localhost:${sessionInfo.port}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionInfo.api_key}`,
    }

    let imageTokens = 0
    const hasImages = opts.messages.some(
      (msg) =>
        Array.isArray(msg.content) &&
        msg.content.some((content) => content.type === 'image_url')
    )

    if (hasImages) {
      try {
        const metadata = await readGgufMetadata(sessionInfo.mmproj_path)
        imageTokens = await this.calculateImageTokens(
          opts.messages,
          metadata.metadata
        )
      } catch (error) {
        logger.warn('Failed to calculate image tokens:', error)
        imageTokens = this.estimateImageTokensFallback(opts.messages)
      }
    }

    const tokenizeRequest = {
      messages: messagesForTemplate,
      tools: [],
      chat_template_kwargs: opts.chat_template_kwargs || {
        enable_thinking: false,
      },
    }

    try {
      const applyResult = await invoke<string>('post_local_http', {
        url: `${baseUrl}/apply-template`,
        headers,
        body: JSON.stringify(tokenizeRequest),
        timeoutSecs: 10,
      })
      const parsedPrompt = JSON.parse(applyResult)

      const tokenizeResult = await invoke<string>('post_local_http', {
        url: `${baseUrl}/tokenize`,
        headers,
        body: JSON.stringify({ content: parsedPrompt.prompt }),
        timeoutSecs: 10,
      })
      const dataTokens = JSON.parse(tokenizeResult)
      const textTokens = dataTokens.tokens?.length || 0

      return textTokens + imageTokens
    } catch (e) {
      console.warn('[atomic-prism] error in tokenize chain:', String(e))
    }
    return 0
  }

  private async calculateImageTokens(
    messages: chatCompletionRequestMessage[],
    metadata: Record<string, string>
  ): Promise<number> {
    // Extract vision parameters from metadata
    const projectionDim =
      Math.floor(Number(metadata['clip.vision.projection_dim']) / 10) || 256

    // Count images in messages
    let imageCount = 0
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        imageCount += message.content.filter(
          (content) => content.type === 'image_url'
        ).length
      }
    }

    return projectionDim * imageCount - imageCount // remove the lingering <__image__> placeholder token
  }

  private estimateImageTokensFallback(
    messages: chatCompletionRequestMessage[]
  ): number {
    // Fallback estimation if metadata reading fails
    const estimatedTokensPerImage = 256 // Gemma's siglip

    let imageCount = 0
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        imageCount += message.content.filter(
          (content) => content.type === 'image_url'
        ).length
      }
    }

    return imageCount * estimatedTokensPerImage - imageCount // remove the lingering <__image__> placeholder token
  }
}
