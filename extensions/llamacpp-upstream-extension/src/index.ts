/**
 * @file This file exports a class that implements the InferenceExtension interface from the @janhq/core package.
 * The class provides methods for initializing and stopping a model, and for making inference requests.
 * It also subscribes to events emitted by the @janhq/core package and handles new message requests.
 * @version 1.0.0
 * @module llamacpp-extension/src/index
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
import {
  listSupportedBackends,
  isBackendInstalled,
  getBackendExePath,
  getBackendDir,
  getLocalInstalledBackends,
  cleanupIncompleteBackends,
  fetchRemoteBackends,
  friendlyBackendLabel,
  isConcreteOfGpuFamily,
  resolveGpuFamilyConcrete,
  mergeBackendOptions,
  type InstalledBackendPack,
} from './backend'
import { invoke, Channel } from '@tauri-apps/api/core'
import {
  TRANSCRIPTION_IDLE_UNLOAD_MS,
  TRANSCRIPTION_LOAD_OVERRIDES,
  TRANSCRIPTION_MMPROJ_URL,
  TRANSCRIPTION_MODEL_ID,
  TRANSCRIPTION_MODEL_URL,
} from './transcriptionRegistry'
import {
  getProxyConfig,
  isConcreteVersionBackend,
  hasEmbeddedMtp,
  ggufShardSetPaths,
  isDownloadableUrl,
  isEmbeddingGguf,
  classifyProjector,
} from './util'
import {
  resolveGemmaMtpDraft,
  checkGemmaMtpSupport,
  gemmaMtpDraftUrl,
  type GemmaMtpDraft,
} from './gemmaMtpRegistry'
import {
  resolveDflashDraft,
  listDflashDrafts,
  checkDflashSupport,
  dflashDraftUrl,
  type DflashDraft,
} from './dflashRegistry'
import { basename } from '@tauri-apps/api/path'
import { getSystemInfo } from './hardware'
import * as coreRuntime from './adapter/coreRuntime'
import { LoadCancelTracker, toLoadError } from '../../shared/loadCancel'
import {
  buildEngineUpdateOffer,
  clearEngineUpdateOffer,
  publishEngineUpdateOffer,
} from './engineUpdateOffer'
import {
  readGgufMetadata,
  isModelSupported,
  LlamacppConfig,
  DownloadItem,
  ModelConfig,
  EmbeddingResponse,
  DeviceList,
  mapOldBackendToNew,
  findLatestVersionForBackend,
  prioritizeBackends,
  removeOldBackendVersions,
  shouldMigrateBackend,
  handleSettingUpdate,
  installBundledBackend,
  checkBackendForUpdates as checkBackendForUpdatesFromRust,
  getSupportedFeaturesFromRust,
  normalizeFeatures,
  checkSpecTypeSupport,
} from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
import type { RuntimeDeviceInfo } from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/types'

// Error message constant - matches web-app/src/utils/error.ts
const OUT_OF_CONTEXT_SIZE = 'the request exceeds the available context size.'

/// Payload emitted by the Rust proxy when it detects a context-limit error
/// that we (the TS side) should recover from by reloading the backend with
/// a larger ctx window.
interface AutoIncreaseCtxRequest {
  request_id: string
  backend: 'llamacpp' | 'llamacpp-upstream' | 'mlx'
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

/// The voice model has not been downloaded yet. The UI turns this into the
/// install prompt rather than an error toast.
const ERR_TRANSCRIPTION_MODEL_MISSING = 'TRANSCRIPTION_MODEL_MISSING'
/// The running backend cannot execute the voice model's audio projector.
/// Terminal — unlike vision, there is no useful text-only fallback.
const ERR_TRANSCRIPTION_UNSUPPORTED = 'TRANSCRIPTION_UNSUPPORTED'
const DFLASH_SPEC_TYPE = 'draft-dflash'
/// The caller asked to download the `latest/<backend>` sentinel instead of a
/// concrete release tag. The download is refused before it reaches the core,
/// so this is a routing defect to fix, not a crash.
const ERR_BACKEND_TAG_UNRESOLVED = 'BACKEND_TAG_UNRESOLVED'
const CORE_SETTINGS_CHANGED_EVENT = 'atomic-core://settings:changed'

function stableSettingsFingerprint(values: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)])
    )
  }
  return JSON.stringify(stable(values))
}

/**
 * Override the default app.log function to use Jan's logging system.
 * @param args
 */
const logger = {
  info: function (...args: any[]) {
    console.log(...args)
    info(args.map((arg) => ` ${arg}`).join(` `))
  },
  warn: function (...args: any[]) {
    console.warn(...args)
    warn(args.map((arg) => ` ${arg}`).join(` `))
  },
  error: function (...args: any[]) {
    console.error(...args)
    error(args.map((arg) => ` ${arg}`).join(` `))
  },
}

const UPSTREAM_BACKEND_TYPE_KEY = 'atomic_llamacpp_upstream_backend_type'
const LEGACY_SHARED_BACKEND_TYPE_KEY = 'llama_cpp_backend_type'

function isUpstreamBackendType(value: string): boolean {
  return (
    value.startsWith('win-') ||
    value.startsWith('linux-cpu-') ||
    value.startsWith('linux-vulkan-') ||
    value.startsWith('macos-')
  )
}

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

/**
 * A class that implements the InferenceExtension interface from the @janhq/core package.
 * The class provides methods for initializing and stopping a model, and for making inference requests.
 * It also subscribes to events emitted by the @janhq/core package and handles new message requests.
 */

/**
 * Parse the build number from a llama.cpp version string like "b6325".
 * Returns the numeric portion, or null if the format doesn't match.
 */
function parseBuildNumber(version: string): number | null {
  const match = version.match(/^b(\d+)$/)
  return match ? parseInt(match[1], 10) : null
}

function stripBom(s: string): string {
  return s.replace(/\uFEFF/g, '').trim()
}

function backendCategoryToLabel(category: string): string {
  switch (category) {
    case 'cuda-cu13':
      return 'CUDA 13'
    case 'cuda-cu13.0':
      return 'CUDA 13'
    case 'cuda-cu12.4':
      return 'CUDA 12'
    case 'cuda-cu12.0':
      return 'CUDA 12'
    case 'cuda-cu11.7':
      return 'CUDA 11'
    case 'vulkan':
      return 'Vulkan'
    default:
      return category
  }
}

function get_backend_category(backend: string): string {
  // ggml-org native Windows names (matched first so `cuda-13.x` / `cuda-12.4`
  // don't fall through to the legacy janhq categories).
  if (/cuda-13\.\d+/.test(backend)) return 'cuda-cu13'
  if (backend.includes('cuda-12.4')) return 'cuda-cu12.4'
  // Legacy janhq mirror names.
  if (backend.includes('cuda-13-common_cpus')) return 'cuda-cu13.0'
  if (backend.includes('cuda-12-common_cpus') || backend.includes('cu12.0'))
    return 'cuda-cu12.0'
  if (backend.includes('cuda-11-common_cpus') || backend.includes('cu11.7'))
    return 'cuda-cu11.7'
  if (backend.includes('vulkan')) return 'vulkan'
  if (backend === 'win-cpu-x64' || backend === 'win-cpu-arm64') return 'cpu'
  if (backend.includes('common_cpus')) return 'common_cpus'
  if (backend.includes('avx512')) return 'avx512'
  if (backend.includes('avx2')) return 'avx2'
  if (
    backend.includes('avx') &&
    !backend.includes('avx2') &&
    !backend.includes('avx512')
  )
    return 'avx'
  if (backend.includes('noavx')) return 'noavx'
  return 'unknown'
}

// Folder structure for llamacpp extension:
// <Jan's data folder>/llamacpp
//  - models/<modelId>/
//    - model.yml (required)
//    - model.gguf (optional, present if downloaded from URL)
//    - mmproj.gguf (optional, present if mmproj exists and it was downloaded from URL)
// Contents of model.yml can be found in ModelConfig interface
//
//  - backends/<backend_version>/<backend_type>/
//    - build/bin/llama-server (or llama-server.exe on Windows)
//
//  - lib/
//    - e.g. libcudart.so.12

/**
 * The on-disk subfolder used by BOTH llama.cpp providers (turboquant fork
 * and upstream `ggml-org/llama.cpp`) for model storage. Backends and
 * provider-specific settings stay separate under each provider's own
 * folder; only the GGUF tree is shared so a model downloaded once is
 * runnable by either engine.
 */
const MODELS_PROVIDER_ROOT = 'llamacpp'

/**
 * Outcome of `detectIdealBackendType()`. ATO-161: distinguishes the two
 * cases that used to both collapse to `null` and produce the misleading
 * "You're already on the optimal backend" toast:
 *   - `gpu`             — a better GPU backend exists for this host.
 *   - `cpu-optimal`     — CPU genuinely is the best this hardware can do
 *                         (no CUDA/Vulkan capability detected).
 *   - `detection-failed`— detection could not complete (ggml-org release
 *                         stream unreachable/slow, hardware probe threw, or
 *                         the lookup timed out) — the current backend must
 *                         be left untouched and the user told to retry.
 */
type IdealBackendResult =
  | { kind: 'gpu'; backend: string }
  | { kind: 'cpu-optimal' }
  | { kind: 'detection-failed' }

export const OPTIMAL_BACKEND_CACHE_KEY =
  'atomic_llamacpp_upstream_optimal_backend_v1'

type OptimalBackendCacheBase = {
  schemaVersion: 1
  provider: 'llamacpp-upstream'
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
 * detection could not complete (ATO-161). Callers
 * (`SetupBackendStep` / `$providerName` "Find optimal backend" / the
 * post-upgrade auto-recheck) match on this to show a "couldn't detect —
 * keeping current backend" message instead of silently treating it as
 * "CPU is optimal". The web-app handler matches the literal value (it can't
 * import the extension bundle), so keep the two in sync.
 */
export const BACKEND_DETECTION_FAILED = 'BACKEND_DETECTION_FAILED'

/// Smallest GPU worth moving a host off the CPU build for. Below this the
/// KV cache of even the lightest recommended model does not fit beside the
/// weights, and the GPU backend would spill straight back to RAM.
///
/// Platform-neutral on purpose. ATO-464 lowered this from 6 GiB to 2 GiB for
/// Linux with reasoning that is a property of the backend, not of the OS
/// ("Vulkan is a third of CUDA's throughput and radically more than the CPU
/// fallback"), but left Windows on an inline `6 * 1024`. That asymmetry told
/// a 4 GB Radeon owner "CPU is optimal" and cached the verdict, while a 4 GB
/// GeForce on the same code path got CUDA — the CUDA tiers carry no VRAM
/// gate at all.
const GPU_BACKEND_MIN_VRAM_MIB = 2 * 1024

export default class llamacpp_upstream_extension extends AIEngine {
  provider: string = 'llamacpp-upstream'
  autoUnload: boolean = false
  timeout: number = 1800
  llamacpp_env: string = ''
  readonly providerId: string = 'llamacpp-upstream'

  private config: LlamacppConfig
  private providerPath!: string
  private isConfiguringBackends: boolean = false
  private isUpdatingBackend: boolean = false
  private isInitializing: boolean = true
  private configureBackendsPromise: Promise<void> | null = null
  /// Successful readiness is scoped to one attachment generation and one legacy settings image.
  /// A core restart loses the in-memory hardware override, while an app-side settings change needs
  /// a new three-way import even when the process stayed up.
  private coreReady: { key: string; promise: Promise<void> } | undefined
  private coreSettingsMirror: Promise<void> = Promise.resolve()
  private isMirroringCoreSettings = false
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
  /// Unloads the voice model once dictation has been idle long enough. It
  /// runs alongside the chat model, so leaving ~3 GB resident forever after
  /// one dictation would be rude.
  private transcriptionIdleTimer?: ReturnType<typeof setTimeout>

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
        value.provider !== 'llamacpp-upstream' ||
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

  private async persistOptimalBackendCache(
    detection: Exclude<IdealBackendResult, { kind: 'detection-failed' }>,
    currentBackend: string,
    recommendedBackend?: string | null
  ): Promise<OptimalBackendCacheRecord> {
    const record: OptimalBackendCacheRecord =
      detection.kind === 'cpu-optimal'
        ? {
            schemaVersion: 1,
            provider: 'llamacpp-upstream',
            detectedAt: Date.now(),
            detectionKind: 'cpu-optimal',
            currentBackend,
            recommendedCategory: 'CPU',
          }
        : {
            schemaVersion: 1,
            provider: 'llamacpp-upstream',
            detectedAt: Date.now(),
            detectionKind: 'gpu',
            currentBackend,
            idealBackendId: detection.backend,
            ...(recommendedBackend ? { recommendedBackend } : {}),
            recommendedCategory: backendCategoryToLabel(
              get_backend_category(detection.backend)
            ),
          }

    await this.storeOptimalRecord(record)
    return record
  }

  private applyOptimalState(state: coreRuntime.CoreOptimalState<OptimalBackendCacheRecord>): void {
    if (state.revision < this.optimalRevision) return
    this.optimalRevision = state.revision
    if (state.optimal) localStorage.setItem(OPTIMAL_BACKEND_CACHE_KEY, JSON.stringify(state.optimal))
    else localStorage.removeItem(OPTIMAL_BACKEND_CACHE_KEY)
  }

  /**
   * The core stores the record; `localStorage` only holds the synchronous UI copy. The core commit
   * precedes that copy, so the UI never shows an uncommitted result.
   */
  private async storeOptimalRecord(
    record: OptimalBackendCacheRecord | null
  ): Promise<void> {
    const epoch = this.optimalEpoch
    try {
      const state = await coreRuntime.setOptimalCache(record, this.optimalRevision)
      if (epoch === this.optimalEpoch) this.applyOptimalState(state)
    } catch (error) {
      // A CLI may have won the revision race; take its answer, never retry an obsolete detection.
      const state = await coreRuntime.getOptimalCache<OptimalBackendCacheRecord>()
      if (epoch === this.optimalEpoch) this.applyOptimalState(state)
      throw error
    }
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

  private async clearOptimalBackendCache(): Promise<void> {
    await this.storeOptimalRecord(null)
  }

  override async onLoad(): Promise<void> {
    super.onLoad() // Calls registerEngine() from AIEngine

    let settings = structuredClone(SETTINGS) // Clone to modify settings definition before registration

    // Preserve persisted `version_backend` across sessions.
    //
    // `registerSettings()` (in core extension.ts) keeps the persisted value
    // ONLY if the new `options` list contains it; otherwise it silently
    // resets value to `options[0]`. On every cold start the persisted
    // `options` may be a stale subset (e.g. `[bundled]`) that no longer
    // contains the previously selected GPU backend (e.g. CUDA), in which
    // case the persisted value is wiped to bundled — silently undoing the
    // user's last hot-swap.
    //
    // Solution: before calling `registerSettings(SETTINGS)` (which arrives
    // with empty options), inject the persisted value into the new options
    // list so the deduplication check passes and the value survives.
    //
    // This used to skip macOS, where the provider only ever had the single
    // bundled build and there was nothing to lose. Now that macOS resolves
    // its builds from the manifest, a downloaded tag is exactly as losable
    // there as a CUDA build is on Windows.
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
    this.config = loadedConfig as LlamacppConfig

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

    // KV cache types are user-selectable for the upstream provider via the
    // `cache_type_k` / `cache_type_v` dropdowns and default to vanilla
    // llama.cpp's native `f16`. We intentionally do NOT run the legacy
    // f16->q8_0 (v1) or the f16-clearing (v4) migrations here: turbo* types
    // are fork-only, the standard types are exposed directly in settings,
    // and `args.rs` already skips `--cache-type-k/-v` when the value is `f16`.

    // NOTE: v2 turbo3 KV-cache migration is intentionally skipped for the
    // upstream provider — vanilla ggml-org/llama.cpp does not implement the
    // turboquant KV types.

    // Fit on by default; undo the migration that once forced it off.
    await this.migrateFitDefaultOn()

    this.timeout = this.config.timeout
    this.llamacpp_env = this.config.llamacpp_env
    this.autoUnload = this.config.auto_unload ?? true

    // This sets the base directory where model files for this provider are stored.
    this.getProviderPath()

    // Activate a pending backend that was downloaded before the last restart.
    await this.activatePendingBackend()

    // ATO-179 (AC3): sweep orphan / incomplete backend folders (exist on disk
    // but carry no llama-server exe — e.g. empty stubs from a failed download)
    // so they neither masquerade as installed nor block a clean re-download.
    // Best-effort; runs after activatePendingBackend (a completed pending
    // backend has a valid exe and is therefore never removed) and before
    // configureBackends.
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
        'LlamaCPP: bridging onModelValidationStarted event',
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
        // The Rust proxy emits `backend: 'llamacpp-upstream'` for sessions
        // owned by the upstream `LlamacppState` pool; only those events
        // belong to this extension. Turboquant sessions are handled by the
        // `llamacpp-extension` listener.
        if (event.payload?.backend !== 'llamacpp-upstream') return
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
        void this.enqueueCoreSettingsMirror()
          .catch((error) => {
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

    //* configureBackends can take a long time downloading the engine — don't await, otherwise the whole UI waits for it to finish.
    this.configureBackendsPromise = this.configureBackends()
      .catch((err) => {
        //! Previously the rejected promise was lost; without a log it's hard to diagnose a perpetual "loading" in settings.
        logger.error('configureBackends failed:', err)
      })
      // Reconcile the selected backend after configureBackends has resolved
      // legacy/latest values to a concrete version/backend pair.
      .then(() => this.reconcileBackendReleaseTag())
      .finally(() => {
        this.isInitializing = false
        this.configureBackendsPromise = null
      })
  }

  private getStoredBackendType(): string | null {
    try {
      const value = localStorage.getItem(UPSTREAM_BACKEND_TYPE_KEY)
      if (value) return stripBom(value)

      const legacyValue = localStorage.getItem(LEGACY_SHARED_BACKEND_TYPE_KEY)
      const normalizedLegacyValue = legacyValue ? stripBom(legacyValue) : null
      if (
        normalizedLegacyValue &&
        isUpstreamBackendType(normalizedLegacyValue)
      ) {
        localStorage.setItem(UPSTREAM_BACKEND_TYPE_KEY, normalizedLegacyValue)
        logger.info(
          `Migrated upstream backend preference from legacy shared key: ${normalizedLegacyValue}`
        )
        return normalizedLegacyValue
      }

      return null
    } catch (error) {
      logger.warn('Failed to read backend type from localStorage:', error)
      return null
    }
  }

  private setStoredBackendType(backendType: string): void {
    try {
      localStorage.setItem(UPSTREAM_BACKEND_TYPE_KEY, backendType)
      logger.info(`Stored backend type preference: ${backendType}`)
    } catch (error) {
      logger.warn('Failed to store backend type in localStorage:', error)
    }
  }

  private clearStoredBackendType(): void {
    try {
      localStorage.removeItem(UPSTREAM_BACKEND_TYPE_KEY)
      logger.info('Cleared stored backend type preference')
    } catch (error) {
      logger.warn('Failed to clear backend type from localStorage:', error)
    }
  }

  private async migrateKvCacheDefaults(): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_kv_cache_migrated_v1'
    if (localStorage.getItem(MIGRATION_KEY)) return

    const keysToMigrate = ['cache_type_k', 'cache_type_v'] as const
    const needsMigration = keysToMigrate.some((k) => this.config[k] === 'f16')

    if (needsMigration) {
      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (
            keysToMigrate.includes(
              item.key as (typeof keysToMigrate)[number]
            ) &&
            item.controllerProps.value === 'f16'
          ) {
            item.controllerProps.value = 'q8_0'
          }
          return item
        })
      )
      for (const k of keysToMigrate) {
        if (this.config[k] === 'f16') this.config[k] = 'q8_0'
      }
      logger.info('Migrated KV cache types from f16 to q8_0')
    }

    localStorage.setItem(MIGRATION_KEY, '1')
  }

  private async clearLegacyKvCacheSettings(): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_upstream_kv_cache_cleared_v1'
    if (localStorage.getItem(MIGRATION_KEY)) return

    const obsoleteKeys = ['cache_type_k', 'cache_type_v'] as const

    try {
      const settings = await this.getSettings()
      const filtered = settings.filter(
        (item) =>
          !(obsoleteKeys as readonly string[]).includes(item.key as string)
      )
      if (filtered.length !== settings.length) {
        await this.updateSettings(filtered)
      }
    } catch (err) {
      logger.warn(
        'clearLegacyKvCacheSettings: failed to prune settings list:',
        err
      )
    }

    const cfg = this.config as Record<string, unknown>
    for (const k of obsoleteKeys) {
      if (cfg[k] !== undefined && cfg[k] !== '') {
        cfg[k] = ''
      }
    }

    localStorage.setItem(MIGRATION_KEY, '1')
    logger.info(
      'Cleared legacy KV cache type overrides; falling back to llama.cpp defaults'
    )
  }

  private async migrateKvCacheToTurbo3(): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_kv_cache_migrated_turbo3_v2'
    if (localStorage.getItem(MIGRATION_KEY)) return

    const keysToMigrate = ['cache_type_k', 'cache_type_v'] as const
    const needsMigration = keysToMigrate.some(
      (k) => this.config[k] !== 'turbo3'
    )

    if (needsMigration) {
      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (
            keysToMigrate.includes(
              item.key as (typeof keysToMigrate)[number]
            ) &&
            item.controllerProps.value !== 'turbo3'
          ) {
            item.controllerProps.value = 'turbo3'
          }
          return item
        })
      )
      for (const k of keysToMigrate) {
        if (this.config[k] !== 'turbo3') this.config[k] = 'turbo3'
      }
      logger.info('Migrated KV cache types to turbo3')
    }

    localStorage.setItem(MIGRATION_KEY, '1')
  }

  /**
   * Fit is on by default (ATO-465). A one-shot migration used to force it
   * OFF for everyone — including users who had turned it on — so a profile
   * that went through it carries `fit: false` without anyone having chosen
   * that. Undo it once, but only where nothing else about fit was touched:
   * a non-default floor or target says the user configured fit on purpose,
   * and their `false` stands.
   */
  private async migrateFitDefaultOn(): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_fit_enabled_v2'
    const FORCED_OFF_KEY = 'llamacpp_fit_disabled_v1'
    if (localStorage.getItem(MIGRATION_KEY)) return

    const forcedOff = localStorage.getItem(FORCED_OFF_KEY) !== null
    const fitCtx = String(this.config.fit_ctx ?? '').trim()
    const fitTarget = String(this.config.fit_target ?? '').trim()
    const untouched =
      (fitCtx === '' || fitCtx === '4096') &&
      (fitTarget === '' || fitTarget === '1024')

    if (forcedOff && this.config.fit === false && untouched) {
      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (item.key === 'fit') {
            item.controllerProps.value = true
          }
          return item
        })
      )
      this.config.fit = true
      logger.info('Re-enabled fit: it had been forced off by a migration')
    }

    localStorage.removeItem(FORCED_OFF_KEY)
    localStorage.setItem(MIGRATION_KEY, '1')
  }

  private async activatePendingBackend(): Promise<void> {
    const pending = localStorage.getItem('llama_cpp_pending_backend')
    if (!pending) return

    const cleaned = stripBom(pending)
    const parts = cleaned.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      logger.warn(`Invalid pending backend string "${cleaned}", clearing`)
      localStorage.removeItem('llama_cpp_pending_backend')
      return
    }

    const [version, backend] = [parts[0].trim(), parts[1].trim()]

    try {
      const installed = await isBackendInstalled(backend, version)
      if (!installed) {
        logger.warn(`Pending backend ${cleaned} not found on disk, clearing`)
        localStorage.removeItem('llama_cpp_pending_backend')
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
      localStorage.removeItem('llama_cpp_pending_backend')
    }
  }

  private async tryInstallBundledBackend(): Promise<string | null> {
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const backendsDir = await joinPath([
        janDataFolderPath,
        this.providerId,
        'backends',
      ])

      const result = await installBundledBackend(backendsDir)

      if (result.installed && result.backend_string) {
        logger.info(`Bundled backend installed: ${result.backend_string}`)
        return result.backend_string
      } else {
        logger.info('No bundled backend available or already installed')
        return null
      }
    } catch (e) {
      logger.warn('Failed to install bundled backend:', e)
      return null
    }
  }

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

      // Install bundled backend from app resources if no local backends exist
      const bundledBackendString = await this.tryInstallBundledBackend()

      // Immediately apply a backend so the model can load without
      // waiting for the remote backend list (GitHub API can be slow/down).
      //
      // If the persisted UI settings (localStorage `@janhq/llamacpp-extension`)
      // were lost between launches — e.g. the user wiped WebView2 storage via
      // `make dev-windows-cpu`, ran a factoryReset, or the WebView2 cache got
      // corrupted — `this.config.version_backend` arrives empty even though a
      // GPU backend may still be physically installed in the data folder.
      // Without recovery the next branch would silently re-pin bundled CPU and
      // the user would lose their previously selected backend on every restart.
      //
      // Recovery: scan installed backends on disk and pick the best one. This
      // used to skip macOS, where the only build on disk was the bundled one
      // the next branch would apply anyway; with manifest-driven builds a
      // downloaded tag can now be sitting there instead.
      const currentVB = this.config.version_backend || ''
      const persistedMissing =
        !currentVB || currentVB === 'none' || !currentVB.includes('/')

      if (persistedMissing) {
        try {
          const localInstalled = await getLocalInstalledBackends()
          if (localInstalled.length > 0) {
            const recovered = await this.determineBestBackend(localInstalled)
            if (recovered && recovered.includes('/')) {
              this.config.version_backend = recovered
              const recoveredType = recovered.split('/')[1]
              if (recoveredType) {
                this.setStoredBackendType(recoveredType)
              }
              logger.info(
                `[configureBackends] Recovered version_backend from disk: ${recovered} (localStorage was empty)`
              )
            }
          }
        } catch (err) {
          logger.warn(
            'Failed to recover backends from disk; will fall back to bundled:',
            err
          )
        }
      }

      if (bundledBackendString) {
        const vbAfterRecovery = this.config.version_backend || ''
        // ATO-124: treat the unresolved `latest/<backend>` sentinel as
        // "not yet a concrete backend" so the bundled backend is applied over
        // it. The old `!includes('/')` check let the sentinel through, leaving
        // an unresolved `latest/<backend>` pinned → tight retry-loop on load.
        if (!isConcreteVersionBackend(vbAfterRecovery)) {
          this.config.version_backend = bundledBackendString
          logger.info(
            `Applied bundled backend immediately: ${bundledBackendString}`
          )
        }
      }

      // GPU-backend detection does not run *here*, inside
      // `configureBackends()`. It used to, on every launch and again after the
      // remote release fetch, which read in the logs as a periodic "we're
      // trying to install a better backend" pass that never installed anything
      // unless the user clicked through a dialog.
      //
      // Detection is now driven from outside the extension:
      //   1. `StartupBackendCoordinator` calls `refreshOptimalBackendCache()`
      //      once per launch (cached for 24h) and applies the resulting tier
      //      through `downloadRecommendedBackend()`. ROCm is excluded from that
      //      silent path because of its size.
      //   2. `SetupBackendStep` on first-launch onboarding and the manual
      //      "Find optimal backend" button, both via
      //      `recheckOptimalBackend()`.
      //
      // Keeping it out of `configureBackends()` is what makes the coordinator's
      // once-per-launch budget hold: this method also runs on settings changes
      // and recovery paths. Its own responsibilities stay bundled-backend
      // extraction, settings registration, and version auto-upgrade within the
      // same backend family.

      // Static "Latest <variant>" dropdown entries for every variant the
      // upstream release stream ships on this OS. Built from the compile-time
      // `IS_WINDOWS` / `IS_LINUX` constants (no network, no hardware probe) so
      // they ALWAYS appear — even when the remote backend fetch below hangs or
      // fails. Each carries a `latest/<backend>` sentinel; `onSettingUpdate`
      // resolves it to the newest release tag at selection time. The set is
      // intentionally unfiltered by hardware — a deliberate manual override so
      // the user can force-install e.g. CUDA even when the driver gate would
      // normally hide it.
      // ATO-174 (finishes ATO-105): the CUDA entries are *minor-less family*
      // ids (`win-cuda-12-x64` / `win-cuda-13-x64`), matching what the Rust
      // matrix already emits. The concrete minor (`12.4`, `13.3`, …) is
      // resolved against the live ggml-org release stream at selection time
      // by `resolveLatestBackendString` (now family-aware), so a future
      // ggml-org minor bump (13.3 → 13.4) no longer silently dead-ends the
      // manual dropdown. `friendlyBackendLabel` renders these as "CUDA 12.4" /
      // "CUDA 13". `win-rocm-x64` is version-less for the same reason and is
      // offered here even on NVIDIA hosts, since the set is a manual override.
      // macOS has no GPU tiers, and only `macos-arm64` is published to the
      // manifest, so that is the one sentinel worth offering. The
      // architecture is read off the bundled build rather than probed: the
      // installer ships the matching arch by construction. An Intel host gets
      // no sentinel — `latest/macos-x64` would resolve to nothing.
      const macHostVariant = IS_MAC
        ? (bundledBackendString ?? stripBom(this.config.version_backend || ''))
            .split('/')[1]
            ?.trim()
        : undefined
      const staticVariants: string[] = IS_WINDOWS
        ? [
            'win-cpu-x64',
            'win-cuda-12-x64',
            'win-cuda-13-x64',
            'win-rocm-x64',
            'win-vulkan-x64',
          ]
        : IS_LINUX
          ? ['linux-cpu-x64', 'linux-vulkan-x64']
          : macHostVariant === 'macos-arm64'
            ? [macHostVariant]
            : []
      const latestEntries = staticVariants.map((backend) => ({
        value: `latest/${backend}`,
        name: `Latest ${friendlyBackendLabel(backend)}`,
      }))

      // --- Early settings registration with bundled backend ---
      // Register settings with the static "Latest" entries plus at least the
      // bundled backend so the UI isn't stuck in "loading" — and so the
      // manual-variant picker is usable — while the GitHub API responds (or
      // hangs).
      if (bundledBackendString) {
        const earlySettings = structuredClone(SETTINGS)
        const earlyBackendIdx = earlySettings.findIndex(
          (item) => item.key === 'version_backend'
        )
        if (earlyBackendIdx !== -1) {
          const earlySetting = earlySettings[earlyBackendIdx]
          const currentVB = this.config.version_backend || ''
          const earlyOptions = [...latestEntries]
          if (
            currentVB &&
            currentVB !== bundledBackendString &&
            !earlyOptions.some((o) => o.value === currentVB)
          ) {
            earlyOptions.push({ value: currentVB, name: currentVB })
          }
          if (!earlyOptions.some((o) => o.value === bundledBackendString)) {
            earlyOptions.push({
              value: bundledBackendString,
              name: bundledBackendString,
            })
          }
          earlySetting.controllerProps.options = earlyOptions
          earlySetting.controllerProps.value = currentVB || bundledBackendString
        }
        this.registerSettings(earlySettings)
        logger.info(
          '[configureBackends] Early settings registered with bundled backend'
        )
      }

      let version_backends: {
        version: string
        backend: string
        order?: number
      }[] = []

      try {
        logger.info('[configureBackends] Fetching supported backends...')
        version_backends = await listSupportedBackends()
        logger.info(
          `[configureBackends] Got ${version_backends.length} backends: ${version_backends.map((b) => `${b.version}/${b.backend}`).join(', ')}`
        )
        if (version_backends.length === 0) {
          throw new Error(
            'No supported backend binaries found for this system. Backend selection and auto-update will be unavailable.'
          )
        } else {
          version_backends.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
        }
      } catch (error) {
        if (bundledBackendString) {
          logger.warn(
            `Failed to fetch supported backends (${
              error instanceof Error ? error.message : error
            }), continuing with bundled backend: ${bundledBackendString}`
          )
          const [bVer, bBack] = bundledBackendString.split('/')
          if (bVer && bBack) {
            version_backends = [{ version: bVer, backend: bBack, order: 0 }]
          }
        } else {
          throw new Error(
            `Failed to fetch supported backends: ${
              error instanceof Error ? error.message : error
            }`
          )
        }
      }

      // Get stored backend preference
      const storedBackendType = this.getStoredBackendType()
      let bestAvailableBackendString = ''

      // Calculate the "best" backend first, as it's used for fallback and defaults
      bestAvailableBackendString =
        await this.determineBestBackend(version_backends)
      logger.info(
        `[configureBackends] Best backend: ${bestAvailableBackendString}, storedType: ${storedBackendType || '(none)'}`
      )

      if (storedBackendType) {
        // Delegate migration check to Rust
        const migrationTarget = await shouldMigrateBackend(
          storedBackendType,
          version_backends
        )

        if (migrationTarget) {
          logger.info(
            `Migrating stored backend type preference from old '${storedBackendType}' to new common type: '${migrationTarget}'`
          )
          this.setStoredBackendType(migrationTarget)
        }

        const effectiveStoredBackendType = migrationTarget || storedBackendType

        // Use the effective (migrated) type to find the latest version
        const preferredBackendString = await findLatestVersionForBackend(
          version_backends,
          effectiveStoredBackendType
        )

        if (preferredBackendString) {
          // Override bestAvailableBackendString with the user preference
          // The returned string from Rust is "version/backend"
          bestAvailableBackendString = preferredBackendString
          logger.info(
            `Using stored backend preference: ${bestAvailableBackendString}`
          )
        } else {
          // The manifest may be temporarily unreachable, so the user's
          // preference may simply not be visible in version_backends right
          // now. Keep the stored preference; the installed-on-disk guards
          // below ensure we don't downgrade to the bundled build when the
          // saved backend is still on the filesystem. macOS used to clear the
          // preference here so the bundled build could take over, which with
          // a manifest-driven catalog would mean one offline launch is enough
          // to forget the downloaded build.
          logger.warn(
            `Stored backend type '${effectiveStoredBackendType}' not in remote/local list right now; keeping preference (network may be unstable)`
          )
        }
      }

      // Compute once whether the currently-saved version_backend is actually
      // present on disk. Used below to:
      //   - keep the saved option visible in the dropdown even when the
      //     remote backend list (`version_backends`) doesn't include it,
      //   - skip the auto-upgrade swap if the "newer" target isn't
      //     downloaded yet,
      //   - skip the fresh-installation fallback when the saved backend is
      //     still installed locally (e.g. GitHub temporarily unavailable).
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

        // Build the dropdown option-litany in three tiers:
        //   1. The STATIC "Latest <variant>" entries computed near the top of
        //      this method (also used by the early registration above).
        //   2. The catalog for this host — the `atomic-chat-conf` manifest
        //      merged with the disk and gated by hardware. Without this tier
        //      macOS has no "Latest" sentinel and no manifest entries either,
        //      so the list can only ever contain what is already installed and
        //      the user has no way to pick a newer build.
        //   3. Whatever else is on disk, so a side-loaded or de-listed build
        //      stays switchable instead of showing up only in the packs dialog.
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
            `[configureBackends] Failed to list installed backends: ${
              err instanceof Error ? err.message : err
            }`
          )
        }

        backendSetting.controllerProps.options = mergeBackendOptions(
          [latestEntries, catalogEntries, installedEntries],
          bestAvailableBackendString
            ? {
                value: bestAvailableBackendString,
                name: bestAvailableBackendString,
              }
            : undefined
        )

        // Always surface the saved backend, even when neither the manifest nor
        // the disk lists it. Dropping it hands the value to core's
        // `registerSettings()`, which replaces anything missing from the options
        // with `options[0]` — here the `latest/<variant>` sentinel, which
        // `reconcileBackendReleaseTag` can only recover from by downloading. The
        // manifest carries the newest tag alone, so an older saved tag survives
        // in the list purely through its copy on disk, and that copy is what
        // `removeOldBackendVersions` prunes after an update: gating this pin on
        // installed-ness is what let one launch in that window park the provider
        // on the sentinel while the UI read "Latest <variant>".
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
            `Saved backend ${savedVB} not present in version_backends list — pinning it into options (installed locally: ${savedVbIsInstalled})`
          )
        }

        // Set the recommended backend based on bestAvailableBackendString
        // (already forced into the options list by `mergeBackendOptions`).
        if (bestAvailableBackendString) {
          backendSetting.controllerProps.recommended =
            bestAvailableBackendString
        }

        const savedBackendSetting = await this.getSetting<string>(
          'version_backend',
          originalDefaultBackendValue
        )

        // Determine initial UI default based on priority:
        // 1. Saved setting (if valid and not original default)
        // 2. Best available for stored backend type or automatic best
        // 3. Original default
        let initialUiDefault = originalDefaultBackendValue

        if (
          savedBackendSetting &&
          savedBackendSetting !== originalDefaultBackendValue
        ) {
          const [savedVersion, savedBackend] = savedBackendSetting.split('/')
          if (savedVersion && savedBackend) {
            const normalizedBackend = await mapOldBackendToNew(savedBackend)

            // Always prefer the latest downloaded version for the saved backend type
            const latestForType = await findLatestVersionForBackend(
              version_backends,
              normalizedBackend
            )
            initialUiDefault =
              latestForType || `${savedVersion}/${normalizedBackend}`

            const currentStoredBackend = this.getStoredBackendType()
            if (currentStoredBackend !== normalizedBackend) {
              this.setStoredBackendType(normalizedBackend)
              logger.info(
                `Stored backend type preference from saved setting: ${normalizedBackend}`
              )
            }
          }
        } else if (bestAvailableBackendString) {
          initialUiDefault = bestAvailableBackendString
          // Store the backend type from the best available only if different
          const [, backendType] = bestAvailableBackendString.split('/')
          if (backendType) {
            const currentStoredBackend = this.getStoredBackendType()
            if (currentStoredBackend !== backendType) {
              this.setStoredBackendType(backendType)
              logger.info(
                `Stored backend type preference from best available: ${backendType}`
              )
            }
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

      // First complete option list of the session: the early registration above
      // knows only the bundled build, and the UI reads its provider snapshot
      // while this method is still resolving the manifest. Nothing else
      // announces the swap, so without this the dropdown keeps offering the
      // short list until some unrelated change refreshes the providers.
      if (events && typeof events.emit === 'function') {
        events.emit('settingsChanged', {
          key: 'version_backend',
          value: String(
            settings[backendSettingIndex].controllerProps.value ?? ''
          ),
        })
      }

      let effectiveBackendString = stripBom(this.config.version_backend || '')

      // Auto-upgrade to the latest downloaded version of the same backend type
      if (
        effectiveBackendString &&
        bestAvailableBackendString &&
        effectiveBackendString !== bestAvailableBackendString &&
        effectiveBackendString.includes('/')
      ) {
        const currentType = effectiveBackendString.split('/')[1]?.trim()
        const bestType = bestAvailableBackendString.split('/')[1]?.trim()
        if (currentType && bestType && currentType === bestType) {
          // Only swap when the "newer" target is actually downloaded.
          // Otherwise we'd end up with config pointing at a backend that
          // isn't on disk yet — e.g. after an app update where the bundled
          // CPU got bumped, but the user's CUDA backend hasn't been
          // re-downloaded for the new release tag.
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

      // Force-switch to the bundled backend when it is a newer version of the
      // SAME backend type (e.g. macos-arm64 → macos-arm64 on app update).
      //
      // "Newer" has to be compared, not assumed: the bundled build is
      // reported on every launch, not only when an app update installed it,
      // so switching on "the strings differ" would drag a user who updated
      // the engine at runtime back down to the tag the installer shipped.
      if (
        bundledBackendString &&
        effectiveBackendString &&
        effectiveBackendString.includes('/')
      ) {
        const [bundledVersion, bundledType] = bundledBackendString.split('/')
        const [currentVersion, currentType] = effectiveBackendString.split('/')
        const bundledBuild = parseBuildNumber(stripBom(bundledVersion ?? ''))
        const currentBuild = parseBuildNumber(stripBom(currentVersion ?? ''))
        const isBundledNewer =
          effectiveBackendString !== bundledBackendString &&
          bundledType === currentType &&
          bundledBuild !== null &&
          currentBuild !== null &&
          bundledBuild > currentBuild

        if (isBundledNewer) {
          logger.info(
            `Switching backend from '${effectiveBackendString}' to bundled '${bundledBackendString}' (app update)`
          )
          effectiveBackendString = bundledBackendString
          bestAvailableBackendString = bundledBackendString
        }
      }

      // Handle fresh installation case where version_backend might be 'none' or invalid.
      //
      // The previous condition also reset to bundled whenever the saved
      // backend was missing from `version_backends` — but that list comes
      // partly from a remote GitHub fetch which can fail or return a
      // truncated set, leading to a CUDA→CPU regression on every restart.
      // Guard the fallback with `savedVbIsInstalled`: only force-fallback
      // when the saved backend is genuinely gone from disk.
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
          `Saved backend ${effectiveBackendString} not in remote list but installed locally — keeping it active`
        )
      }

      // Late-phase GPU-backend detection has also been removed —
      // see the comment near the top of this function. Any
      // recommendation now flows through `recheckOptimalBackend()`,
      // which is invoked only by user-driven UI surfaces.
    } finally {
      this.isConfiguringBackends = false
    }
  }

  /**
   * Reconciles the configured upstream backend to the newest release the
   * `atomic-chat-conf` manifest offers, while preserving the selected backend
   * type.
   *
   * The target used to be the compiled-in `PINNED_BACKEND_TAG`, which meant a
   * manifest bump could never reach anyone and — worse — would drag a user who
   * had just updated by hand back down to the app's tag on the next launch.
   * The manifest is ours and only moves once a build is verified, so it is the
   * authority; the compiled-in tag survives as the offline baseline inside
   * `fetchRemoteBackends`.
   *
   * If the newest release does not contain the selected type, the existing
   * backend remains active because `downloadRecommendedBackend` only persists
   * after a successful download.
   */
  private async reconcileBackendReleaseTag(): Promise<void> {
    try {
      const current = stripBom(this.config.version_backend || '')

      // A parked `latest/<variant>` is not a fresh install waiting to be
      // configured: it is what core's `registerSettings()` leaves behind when
      // the stored concrete value falls out of the options list, and treating it
      // as unconfigured used to disable engine updates for good. Resolving it
      // costs nothing when that release is already on disk, and persists a
      // concrete tag this method can reconcile normally from then on.
      if (current.startsWith('latest/')) {
        logger.info(
          `reconcileBackendReleaseTag: resolving parked sentinel '${current}'`
        )
        await this.downloadRecommendedBackend(current)
        return
      }

      if (!isConcreteVersionBackend(current)) {
        logger.info(
          'reconcileBackendReleaseTag: no concrete backend configured yet, skipping'
        )
        return
      }

      const currentType = current.slice(current.indexOf('/') + 1)

      const { updateNeeded, targetBackend } =
        await this.checkBackendForUpdates()
      const targetType = targetBackend?.split('/')[1]?.trim()
      if (!updateNeeded || !targetBackend || !targetType) return

      // A tag bump must never move anyone between backend families.
      const migratedCurrentType = await mapOldBackendToNew(currentType)
      const sameFamily =
        targetType === currentType ||
        targetType === migratedCurrentType ||
        isConcreteOfGpuFamily(currentType, targetType) ||
        isConcreteOfGpuFamily(migratedCurrentType, targetType)
      if (!sameFamily) {
        logger.warn(
          `reconcileBackendReleaseTag: refusing to switch backend type ${currentType} -> ${targetType}`
        )
        return
      }

      // ATO-528: a tag bump is offered, not taken. It used to download here
      // unannounced — hundreds of megabytes on a launch the user did not ask
      // anything of. The offer is published instead and the web app's
      // `<EngineUpdateBanner />` asks; accepting routes back through
      // `downloadRecommendedBackend()`, which is what this call used to be.
      // The recovery paths above (a parked `latest/` sentinel) still act on
      // their own — those are not updates, they are a broken configuration.
      logger.info(
        `reconcileBackendReleaseTag: offering '${current}' -> '${targetBackend}'`
      )
      await this.offerEngineUpdate(current, targetBackend)
    } catch (err) {
      logger.error(
        'reconcileBackendReleaseTag: failed to reconcile the release tag (keeping current backend):',
        err
      )
    }
  }

  /**
   * Publishes a "new engine build available" offer for the banner (ATO-528).
   *
   * Best-effort in both directions: the archive size is not known on this
   * line (the core downloads the archive from the signed mirror and the
   * extension no longer reads that manifest), so the banner shows no size, and
   * a failure to publish costs the banner, not the app — the offer is rebuilt
   * on the next launch because the tag comparison that produced it is
   * stateless.
   */
  private async offerEngineUpdate(
    currentBackend: string,
    targetBackend: string
  ): Promise<void> {
    try {
      const offer = await buildEngineUpdateOffer(
        this.providerId,
        currentBackend,
        targetBackend,
        async () => undefined
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

  private async determineBestBackend(
    version_backends: { version: string; backend: string }[]
  ): Promise<string> {
    if (version_backends.length === 0) return ''

    // Check GPU memory availability via system info
    let hasEnoughGpuMemory = false
    try {
      const sysInfo = await getSystemInfo()
      for (const gpuInfo of sysInfo.gpus) {
        if (gpuInfo.total_memory >= GPU_BACKEND_MIN_VRAM_MIB) {
          hasEnoughGpuMemory = true
          break
        }
      }
    } catch (error) {
      logger.warn('Failed to get system info for GPU memory check:', error)
      // Default to false if we can't determine GPU memory
      hasEnoughGpuMemory = false
    }

    // Use Rust logic to prioritize backends
    const result = await prioritizeBackends(
      version_backends,
      hasEnoughGpuMemory
    )
    return result.backend_string
  }

  /**
   * Uses hardware detection (CUDA/Vulkan driver info) to determine the ideal
   * backend type for this machine. Returns the backend name string
   * (e.g. "win-cuda-13.4-x64") or null if CPU is already optimal.
   *
   * Naming differs by platform — Windows uses ggml-org native ids
   * (`win-cuda-{12.4,13.3}-x64`, `win-vulkan-x64`); Linux still uses the
   * janhq-mirror names (`linux-cuda-{12,13}-common_cpus-x64`) because the
   * upstream extension is currently only wired on macOS and Windows.
   */
  private async detectIdealBackendType(): Promise<IdealBackendResult> {
    try {
      const sysInfo = await getSystemInfo()
      const rawFeatures = await getSupportedFeaturesFromRust(
        sysInfo.os_type,
        sysInfo.cpu.extensions,
        sysInfo.gpus
      )
      const features = normalizeFeatures(rawFeatures)

      let hasEnoughVram = false
      for (const gpuInfo of sysInfo.gpus) {
        if (gpuInfo.total_memory >= GPU_BACKEND_MIN_VRAM_MIB) {
          hasEnoughVram = true
          break
        }
      }

      // Integrated-only hosts (Intel UHD / AMD Vega iGPU backed by shared
      // system RAM) report >=6 GiB of "VRAM" yet run the Vulkan backend far
      // slower than plain CPU inference. Only offer Vulkan as the *optimal*
      // pick when a discrete GPU is present; otherwise fall through to CPU.
      // Vulkan stays manually installable in Settings -> Providers.
      const hasDiscreteGpu = sysInfo.gpus.some(
        (g) => g.vulkan_info?.device_type === 'DiscreteGpu' || !!g.nvidia_info
      )
      const integratedGpuOnly =
        !hasDiscreteGpu &&
        sysInfo.gpus.length > 0 &&
        sysInfo.gpus.every(
          (g) => g.vulkan_info?.device_type === 'IntegratedGpu'
        )

      const arch = sysInfo.cpu.arch
      const archSuffix =
        arch.includes('aarch64') || arch.includes('arm64') ? 'arm64' : 'x64'

      if (sysInfo.os_type === 'windows') {
        const availableBackends = await listSupportedBackends()
        const pickBackend = (pattern: RegExp): string | null => {
          const candidate = availableBackends.find((b) =>
            pattern.test(b.backend)
          )
          return candidate?.backend ?? null
        }

        const cuda13Backend = pickBackend(
          new RegExp(`^win-cuda-13\\.\\d+-${archSuffix}$`)
        )
        const cuda12Backend = pickBackend(
          new RegExp(`^win-cuda-12\\.\\d+-${archSuffix}$`)
        )
        const rocmBackend = pickBackend(
          new RegExp(`^win-rocm-\\d+\\.\\d+-${archSuffix}$`)
        )
        const vulkanBackend = pickBackend(
          new RegExp(`^win-vulkan-${archSuffix}$`)
        )

        // ggml-org publishes Windows CUDA 13.x and 12.4 builds —
        // CUDA 11 has been dropped upstream. Hosts with driver too old
        // for CUDA 12.4 (~551.61) fall through to Vulkan/CPU below via
        // the feature-flag gating in `get_supported_features`.
        //
        // The first tier the hardware gates admit wins. There is no runtime
        // probe here: spawning `--list-devices` needs a process, and processes
        // belong to the core. The probe was only ever a second, weaker signal
        // — it could skip a tier solely when NVML / the Vulkan loader also saw
        // no matching GPU, and those same readings already decide the feature
        // flags that put a tier on this list. `--list-devices` alone is known
        // to come back empty on hosts whose CUDA inference works
        // (AtomicBot-ai/Atomic-Chat#25), so it is never a verdict by itself.
        const tiers: string[] = []
        if (features.cuda13 && cuda13Backend) tiers.push(cuda13Backend)
        if (features.cuda12 && cuda12Backend) tiers.push(cuda12Backend)
        // ROCm outranks Vulkan on the AMD cards it covers, and `features.rocm`
        // is already gated on the generated PCI-id table, so reaching this
        // point means the archive is compiled for this gfx target.
        if (features.rocm && hasEnoughVram && rocmBackend)
          tiers.push(rocmBackend)
        if (
          features.vulkan &&
          hasEnoughVram &&
          vulkanBackend &&
          !integratedGpuOnly
        )
          tiers.push(vulkanBackend)

        if (tiers.length > 0) {
          return { kind: 'gpu', backend: tiers[0] }
        }

        // ATO-161/ATO-174: no GPU tier could be picked. Distinguish "CPU is
        // genuinely optimal" from "we couldn't fetch the GPU options". The
        // host is GPU-capable when the driver/feature gate says CUDA/Vulkan
        // is usable; ggml-org *always* publishes CUDA + Vulkan Windows
        // assets, so a GPU-capable host with NO GPU backend anywhere in the
        // merged local+remote catalog means the manifest fetch
        // (`fetchRemoteBackends`) returned `[]` — i.e.
        // raw.githubusercontent.com was unreachable/slow, not that CPU is best.
        const gpuCapable =
          features.cuda13 ||
          features.cuda12 ||
          (features.rocm && hasEnoughVram) ||
          (features.vulkan && hasEnoughVram && !integratedGpuOnly)
        const anyGpuBackendAvailable = availableBackends.some((b) =>
          /-(cuda-\d|rocm-\d|vulkan)-/.test(b.backend)
        )
        if (gpuCapable && !anyGpuBackendAvailable) {
          logger.warn(
            'detectIdealBackendType: GPU-capable host but no GPU backend in catalog — treating as detection failure (release stream likely unreachable)'
          )
          return { kind: 'detection-failed' }
        }
        return { kind: 'cpu-optimal' }
      }

      // Linux — per 2026-05-28 ADR *Linux ships only `llamacpp-upstream`*,
      // the only GPU-accelerated backend `ggml-org/llama.cpp` publishes for
      // Linux is Vulkan. There are no `ubuntu-cuda-*` release artefacts,
      // so even on NVIDIA hosts the optimal upgrade path is Vulkan (which
      // works with the proprietary NVIDIA driver's Vulkan ICD just fine).
      // `features.vulkan` is only `true` when libvulkan.so.1 loaded AND
      // `vkEnumeratePhysicalDevices` returned ≥1 GPU — so this branch
      // never recommends Vulkan on a host that can't actually run it.
      //
      // The `cuda*` feature flags are intentionally ignored here; they
      // can still be true on a Linux box with a recent NVIDIA driver,
      // but recommending a CUDA backend we don't ship would just produce
      // a 404 at download time. `determine_supported_backends` in the
      // Rust plugin mirrors this matrix.
      if (sysInfo.os_type === 'linux') {
        // Linux installs on the CPU build, and Vulkan is the only GPU build
        // there is to upgrade to. The gate used to demand a discrete card
        // with 6 GiB, and a host that failed it was `cpu-optimal` for good —
        // nothing ever asked again. Measured on this platform Vulkan is a
        // third of CUDA's throughput and radically more than the CPU
        // fallback, so a 4 GB card or a capable integrated GPU is worth it
        // (ATO-464). Only a device the loader can actually see qualifies:
        // `features.vulkan` means libvulkan.so.1 loaded AND enumerated it.
        const anyVulkanDevice = sysInfo.gpus.some(
          (g) => g.total_memory >= GPU_BACKEND_MIN_VRAM_MIB
        )
        if (features.vulkan && archSuffix === 'x64' && anyVulkanDevice) {
          return { kind: 'gpu', backend: 'linux-vulkan-x64' }
        }
        // The hardware plugin sees a GPU but the Vulkan loader does not: a
        // fresh install without libvulkan1, or a driver still settling.
        // Not a verdict — ask again next launch instead of pinning the host
        // to CPU for the life of the profile.
        if (
          !features.vulkan &&
          archSuffix === 'x64' &&
          sysInfo.gpus.length > 0
        ) {
          return { kind: 'detection-failed' }
        }
        // No accelerator at all: the CPU build is the right build.
        return { kind: 'cpu-optimal' }
      }

      return { kind: 'cpu-optimal' }
    } catch (err) {
      logger.warn('detectIdealBackendType failed:', err)
      return { kind: 'detection-failed' }
    }
  }

  /**
   * Ensure a concrete `<tag>/<backend>` string is present in the
   * `version_backend` dropdown options, persisting directly to localStorage.
   *
   * `Extension.updateSettings()` (core) only copies `controllerProps.value`,
   * never `controllerProps.options`, and the option list is otherwise rebuilt
   * solely by `configureBackends()` (startup / "Install from file"). The
   * "Find optimal backend" hot-swap goes download -> `applyBackendLive` ->
   * `updateBackend` and never re-runs `configureBackends()`, so the freshly
   * downloaded backend (e.g. a concrete CUDA tag) ended up active but missing
   * from the picker (ATO-218). We append the option here, before the value is
   * written, so it survives the subsequent `updateSettings` (which re-reads
   * the full settings from storage and only overwrites `value`).
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

      // Download new backend using the original asset/backend name
      await this.ensureBackendReady(backend, version)

      // Add delay on Windows
      if (IS_WINDOWS) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      // Map backend type for stored preference only (not for download/config)
      const effectiveBackendType = await mapOldBackendToNew(backend)
      const currentStoredBackend = this.getStoredBackendType()

      // Persist settings and stored preference before mutating in-memory config,
      // so that if any of these steps fail, config remains consistent.

      // ATO-218: make sure the freshly-downloaded backend appears as a
      // dropdown option. `updateSettings` only persists `value`, never
      // `options`, so write the appended option to storage first; the
      // `updateSettings` below then sets the value while preserving the
      // options array it re-reads from storage.
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

      // Store the backend type preference only if it changed
      if (currentStoredBackend !== effectiveBackendType) {
        this.setStoredBackendType(effectiveBackendType)
        logger.info(
          `Updated stored backend type preference: ${effectiveBackendType}`
        )
      }

      // All critical side effects succeeded — now commit to in-memory config
      this.config.version_backend = targetBackendString
      this.config.device = ''

      logger.info(`Successfully updated to backend: ${targetBackendString}`)

      // Emit for updating frontend
      if (events && typeof events.emit === 'function') {
        logger.info(
          `Emitting settingsChanged event for version_backend with value: ${targetBackendString}`
        )
        events.emit('settingsChanged', {
          key: 'version_backend',
          value: targetBackendString,
        })
      }

      // Clean up old versions — best-effort, don't fail the update if this errors.
      // MUST target this provider's own backends tree (`llamacpp-upstream`),
      // never the shared/turboquant `llamacpp` dir — otherwise the upstream
      // auto-upgrade wipes turboquant backends (none of which match the
      // upstream `latest_version`), bricking turboquant-bound models (ATO-153).
      try {
        const janDataFolderPath = await getJanDataFolderPath()
        const backendsDir = await joinPath([
          janDataFolderPath,
          this.providerId,
          'backends',
        ])

        if (IS_WINDOWS) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }

        await removeOldBackendVersions(backendsDir, version, backend)
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

  /**
   * Downloads a recommended GPU backend and applies it without restarting
   * the app whenever possible. Called by the frontend when the user
   * confirms the better-backend popup.
   *
   * Sequencing rationale:
   *   1. Persist `llama_cpp_pending_backend` BEFORE the download so that any
   *      observer reacting to `AppEvent.onBackendDownloadFinished` sees the
   *      pending key already on disk (the download-finished event is emitted
   *      from inside `downloadAndInstallBackend` and previously beat the
   *      pending write, leaving the provider settings page without its
   *      "Restart to activate" pill until a tab refresh).
   *      `activatePendingBackend()` already gates on `isBackendInstalled()`,
   *      so a partial download leaves no harmful state.
   *   2. After a successful download, attempt `applyBackendLive()` for a
   *      hot-swap. On success the pending key is dropped and the UI reacts
   *      to `app:backend-hotswapped`. On failure the pending key stays put
   *      and the user falls back to the classic "restart required" flow.
   */
  async downloadRecommendedBackend(backendString: string): Promise<void> {
    backendString = stripBom(backendString)

    // The recommendation can carry a `latest/<backend>` sentinel (the
    // static "Latest <variant>" dropdown entries, and the offline fallback
    // in `recheckOptimalBackend`). `downloadAndInstallBackend` →
    // `getBackendDownloadUrl` would otherwise build a 404 URL with the
    // literal `latest` tag (ggml-org tags releases as `bXXXX`, never
    // `latest`). Resolve it to a concrete `<tag>/<backend>` here — mirroring
    // what `downloadManualBackend` already does — before anything touches
    // the download URL. (ATO-95)
    if (backendString.startsWith('latest/')) {
      const backendId = backendString.slice('latest/'.length).trim()
      const resolved =
        (await this.resolveLatestBackendString(backendId)) ??
        (await this.newestInstalledOfFamily(backendId))
      if (!resolved) {
        throw new Error(
          `Could not resolve a release for '${backendId}': the ggml-org release stream is unreachable and no version of this backend is installed locally.`
        )
      }
      logger.info(
        `downloadRecommendedBackend: resolved sentinel ${backendString} -> ${resolved}`
      )
      backendString = resolved
    }

    logger.info(`downloadRecommendedBackend: downloading ${backendString}`)
    localStorage.setItem('llama_cpp_pending_backend', backendString)
    try {
      await this.downloadAndInstallBackend(backendString)
    } catch (err) {
      // Download failed — drop the pending marker so the next app launch
      // doesn't try to "activate" a backend that was never installed.
      localStorage.removeItem('llama_cpp_pending_backend')
      throw err
    }
    localStorage.removeItem('llama_cpp_better_backend_recommendation')

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
   * llama.cpp models, clear the pending marker, and notify the UI via a
   * window event.
   *
   * Order matters: `updateBackend()` must commit the new `version_backend`
   * into `this.config` *before* any model is unloaded. Unloading flips the
   * model's status to stopped, which the web-app's local-model auto-start
   * effect (`ChatInput.tsx`) reacts to by immediately reloading it via
   * `switchToModel()`. `load()` hands the app's persisted settings to the core
   * on the way in, so an unload-before-update ordering let that auto-reload
   * race ahead of `updateBackend()` and start `llama-server` on the *old*
   * backend — the UI would then report the switch as complete while the
   * running process silently stayed on the previous (e.g. CPU) build.
   *
   * Failure modes:
   *   - `updateBackend()` throws → we propagate without touching any loaded
   *     model, so a failed hot-swap never kills a working session. Caller
   *     leaves the pending marker in place so `activatePendingBackend()`
   *     retries on next launch.
   *   - `unload()` throws when a session can't be cleanly stopped → we log
   *     and continue; the new backend is already persisted, so the next
   *     load (auto or manual) picks it up regardless.
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

    localStorage.removeItem('llama_cpp_pending_backend')

    // A pending engine-update offer is about this provider's backend, and the
    // backend just changed — whatever it proposed is now either done or stale.
    // The next `reconcileBackendReleaseTag()` republishes it if it still holds.
    clearEngineUpdateOffer(this.providerId)

    // Decoupled from `AppEvent` enum on purpose: a hot-swap completion is
    // a pure UI concern (the dialog/pill in the web app) and does not
    // need to traverse the cross-extension event bus. `window` is always
    // available inside the Tauri WebView2 context where this extension
    // runs.
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

  private async resolveConcreteOptimalBackend(
    idealType: string,
    currentBackend: string,
    operation: string
  ): Promise<string | null> {
    let recommendedBackend: string | null = null
    try {
      const versionBackends = await this.withTimeout(
        listSupportedBackends(),
        20_000,
        []
      )
      recommendedBackend = await findLatestVersionForBackend(
        versionBackends,
        idealType
      )
    } catch (err) {
      logger.warn(
        `${operation}: failed to resolve latest backend for ${idealType}, falling back to current version: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    if (!recommendedBackend) {
      recommendedBackend = await this.withTimeout(
        this.resolveLatestBackendString(idealType),
        20_000,
        null
      )
      if (!recommendedBackend) {
        const fallbackVersion = currentBackend.split('/')[0]
        if (!fallbackVersion) {
          logger.warn(
            `${operation}: could not resolve a concrete tag for ${idealType} and no current backend tag to fall back to`
          )
          return null
        }
        recommendedBackend = `${fallbackVersion}/${idealType}`
      }
    }

    return recommendedBackend
  }

  /**
   * Silently refreshes the provider-scoped optimal-backend cache. Unlike
   * `recheckOptimalBackend`, this never writes the legacy recommendation key
   * and never emits `onBetterBackendDetected`.
   */
  async refreshOptimalBackendCache(options?: {
    hardwareHasNoGpu?: boolean
  }): Promise<OptimalBackendCacheRecord | null> {
    if (IS_MAC) return null

    const detection: IdealBackendResult = options?.hardwareHasNoGpu
      ? { kind: 'cpu-optimal' }
      : await this.withTimeout(this.detectIdealBackendType(), 20_000, {
          kind: 'detection-failed',
        } as const)
    if (detection.kind === 'detection-failed') {
      throw new Error(BACKEND_DETECTION_FAILED)
    }

    const currentBackend = stripBom(this.config.version_backend || '')
    if (detection.kind === 'cpu-optimal') {
      return await this.persistOptimalBackendCache(detection, currentBackend)
    }

    let recommendedBackend: string | null = null
    try {
      recommendedBackend = await this.resolveConcreteOptimalBackend(
        detection.backend,
        currentBackend,
        'refreshOptimalBackendCache'
      )
    } catch (err) {
      logger.warn(
        'refreshOptimalBackendCache: concrete backend resolution failed:',
        err
      )
    }
    return await this.persistOptimalBackendCache(
      detection,
      currentBackend,
      recommendedBackend
    )
  }

  /**
   * Manually re-runs hardware detection and returns a recommendation if a
   * better GPU backend than the current one is available. Used by:
   *   - the dedicated Windows onboarding step (`SetupBackendStep`) to surface
   *     the recommendation deterministically, even after the early/late
   *     auto-emit gates have been disabled by `llama_cpp_onboarding_done`;
   *   - the manual "Find optimal backend" button in provider settings.
   *
   * Side effects (kept consistent with `configureBackends()` early-phase):
   *   - Writes `llama_cpp_better_backend_recommendation` to localStorage so
   *     the existing `useBackendUpdater` mount path picks it up too.
   *   - Emits `AppEvent.onBetterBackendDetected` so the dialog/component
   *     listening through the hook reflects the latest state.
   *
   * Returns the recommendation payload, or `null` when the device is already
   * on the optimal backend category (or detection couldn't decide).
   */
  /**
   * Why the last `recheckOptimalBackend()` returned null.
   *
   * The method returns `null` for four unrelated reasons — this is a Mac, CPU
   * genuinely is the best this hardware can do, the optimal build is already
   * installed, or the catalog has no entry for the detected type — and the
   * return type cannot distinguish them. All four arrived in telemetry as the
   * single value `no_recommendation`, so "46% of users who reach the Windows
   * backend step get no recommendation" could not be read: `already_optimal`
   * is a healthy outcome and is probably the most common of the four.
   *
   * Recorded rather than returned because the method has three callers and is
   * not worth an API break for telemetry. Read via `getLastRecheckOutcome()`.
   */
  private lastRecheckOutcome: string | null = null

  /** See `lastRecheckOutcome`. */
  getLastRecheckOutcome(): string | null {
    return this.lastRecheckOutcome
  }

  async recheckOptimalBackend(): Promise<{
    currentBackend: string
    recommendedBackend: string
    recommendedCategory: string
    provider: string
    version: string
    backendId: string
  } | null> {
    if (IS_MAC) {
      this.lastRecheckOutcome = 'mac'
      return null
    }
    this.lastRecheckOutcome = null
    try {
      logger.info('recheckOptimalBackend: detecting ideal backend type')
      // ATO-104: bound the whole hardware/backend detection so the
      // onboarding "Detecting your hardware" step can never hang forever
      // on a stalled IPC or network lookup. On timeout we behave as if no
      // GPU backend was recommended (CPU is the safe fallback) instead of
      // leaving the spinner up indefinitely.
      // ATO-104: bound the whole detection so onboarding can't hang. ATO-161:
      // a timeout is a *detection failure*, not "CPU is optimal" — the
      // discriminated fallback below makes the two paths distinguishable.
      const detection = await this.withTimeout(
        this.detectIdealBackendType(),
        20_000,
        { kind: 'detection-failed' } as const
      )

      if (detection.kind === 'detection-failed') {
        // ATO-161: detection could not complete (release stream unreachable /
        // slow / rate-limited, hardware probe threw, or the lookup timed out).
        // Leave the current backend AND any prior recommendation untouched and
        // raise a distinct, catchable signal so the UI says "couldn't detect —
        // keeping current backend" rather than the misleading "already on the
        // optimal backend". All callers already wrap this in try/catch
        // (`SetupBackendStep` → detection-failed phase, the settings handler →
        // distinct toast, the post-upgrade auto-recheck → warn-and-continue).
        logger.warn(
          'recheckOptimalBackend: backend detection failed — keeping current backend (no silent CPU fallback)'
        )
        throw new Error(BACKEND_DETECTION_FAILED)
      }

      const currentBackend = stripBom(this.config.version_backend || '')
      if (detection.kind === 'cpu-optimal') {
        // CPU genuinely is the best this hardware can do.
        logger.info(
          'recheckOptimalBackend: CPU is optimal — no better GPU backend for this hardware'
        )
        await this.persistOptimalBackendCache(detection, currentBackend)
        localStorage.removeItem('llama_cpp_better_backend_recommendation')
        this.lastRecheckOutcome = 'cpu_optimal'
        return null
      }

      const idealType = detection.backend
      const idealCat = get_backend_category(idealType)
      const currentType = currentBackend.split('/')[1] || ''
      const currentCat = get_backend_category(currentType)
      const sameCategory = idealCat === currentCat
      const sameBackendType = currentType === idealType
      if (sameCategory && sameBackendType) {
        // Already on the optimal exact backend — no recommendation to surface.
        logger.info(
          `recheckOptimalBackend: already on optimal backend ${currentBackend}`
        )
        await this.persistOptimalBackendCache(
          detection,
          currentBackend,
          currentBackend
        )
        localStorage.removeItem('llama_cpp_better_backend_recommendation')
        this.lastRecheckOutcome = 'already_optimal'
        return null
      }

      // Prefer the latest concrete backend for the detected ideal type.
      // This handles in-family migrations such as CUDA 13.1 -> CUDA 13.3/13.4
      // when the currently-selected backend is still "optimal category"
      // but no longer the latest downloadable variant.
      const recommendedBackend = await this.resolveConcreteOptimalBackend(
        idealType,
        currentBackend,
        'recheckOptimalBackend'
      )
      if (!recommendedBackend) {
        await this.clearOptimalBackendCache()
        // The catalog has nothing for the type detection picked — a gap on our
        // side, not a property of the machine.
        this.lastRecheckOutcome = 'no_catalog_entry'
        localStorage.removeItem('llama_cpp_better_backend_recommendation')
        return null
      }
      await this.persistOptimalBackendCache(
        detection,
        currentBackend,
        recommendedBackend
      )
      if (recommendedBackend === currentBackend) {
        logger.info(
          `recheckOptimalBackend: latest resolved backend is already active (${currentBackend})`
        )
        localStorage.removeItem('llama_cpp_better_backend_recommendation')
        this.lastRecheckOutcome = 'already_optimal'
        return null
      }

      const [recommendedVersion, recommendedId] = recommendedBackend.split('/')
      const payload = {
        currentBackend,
        recommendedBackend,
        recommendedCategory: backendCategoryToLabel(idealCat),
        provider: this.providerId,
        version: recommendedVersion,
        backendId: recommendedId,
      }
      logger.info(
        `recheckOptimalBackend: surfacing recommendation ${recommendedBackend} (${payload.recommendedCategory})`
      )
      localStorage.setItem(
        'llama_cpp_better_backend_recommendation',
        JSON.stringify(payload)
      )
      if (events && typeof events.emit === 'function') {
        events.emit(AppEvent.onBetterBackendDetected, payload)
      }
      return payload
    } catch (err) {
      // ATO-161: propagate the detection-failure sentinel so callers can
      // distinguish it from "CPU is optimal" (return null). Any *other*
      // unexpected error is still swallowed to null — that path was always
      // best-effort and must not regress onboarding.
      if (err instanceof Error && err.message === BACKEND_DETECTION_FAILED) {
        throw err
      }
      logger.warn('recheckOptimalBackend failed:', err)
      this.lastRecheckOutcome = 'threw'
      return null
    }
  }

  async checkBackendForUpdates(options?: { force?: boolean }): Promise<{
    updateNeeded: boolean
    newVersion: string
    targetBackend?: string
  }> {
    try {
      const currentBackend = this.config.version_backend
      if (!currentBackend || !currentBackend.includes('/')) {
        return { updateNeeded: false, newVersion: '0' }
      }

      const version_backends = await listSupportedBackends(options)
      if (version_backends.length === 0) {
        return { updateNeeded: false, newVersion: '0' }
      }

      const result = await checkBackendForUpdatesFromRust(
        currentBackend,
        version_backends
      )
      return {
        updateNeeded: result.update_needed,
        newVersion: result.new_version,
        targetBackend: result.target_backend ?? undefined,
      }
    } catch (err) {
      logger.warn('checkBackendForUpdates failed:', err)
      return { updateNeeded: false, newVersion: '0' }
    }
  }

  /**
   * Manual engine-update check behind the "check for engine updates" button,
   * mirroring the turboquant extension's method of the same name.
   *
   * The manifest is cached for the session and the version list is a snapshot
   * taken at load, so a ggml-org build published to `atomic-chat-conf` while
   * the app was open stays invisible until the next launch. Forcing the
   * manifest refetch is the whole point of the button.
   *
   * Only the decision happens here, and every leg of it is bounded, so a slow
   * or unreachable raw.githubusercontent.com can never leave the button
   * spinning. The caller starts the download without awaiting it — a release
   * archive takes minutes — and the shared `<BackendUpdater />` owns that
   * progress UI.
   */
  async checkForEngineUpdate(): Promise<{
    updateAvailable: boolean
    targetBackend: string | null
  }> {
    const noUpdate = { updateAvailable: false, targetBackend: null }

    // A configuration pass started at load may still be fetching the catalog.
    // Its early phase registers a placeholder option list, so acting on
    // `config` before it finishes would compare against a half-built state.
    if (this.configureBackendsPromise) {
      await this.withTimeout(this.configureBackendsPromise, 20_000, undefined)
    }

    const current = stripBom(this.config.version_backend || '')
    const currentType = current.split('/')[1]?.trim()
    if (!current || current === 'none' || !currentType) return noUpdate

    const { updateNeeded, targetBackend } = await this.withTimeout(
      this.checkBackendForUpdates({ force: true }),
      20_000,
      { updateNeeded: false, newVersion: '0' }
    )
    const targetType = targetBackend?.split('/')[1]?.trim()
    if (!updateNeeded || !targetBackend || !targetType) return noUpdate

    // A tag bump must never move anyone between backend families. Legacy ids
    // may land on their migrated form, which is what Rust resolves them to;
    // a CUDA minor bump within the same major is a family match, not a switch.
    const migratedCurrentType = await mapOldBackendToNew(currentType)
    const sameFamily =
      targetType === currentType ||
      targetType === migratedCurrentType ||
      isConcreteOfGpuFamily(currentType, targetType) ||
      isConcreteOfGpuFamily(migratedCurrentType, targetType)
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

  private async ensureFinalBackendInstallation(
    backendString: string
  ): Promise<void> {
    if (!backendString) {
      logger.warn('No backend specified for final installation check')
      return
    }

    const [selectedVersion, selectedBackend] = backendString
      .split('/')
      .map((part) => part?.trim())

    if (!selectedVersion || !selectedBackend) {
      logger.warn(`Invalid backend format: ${backendString}`)
      return
    }

    try {
      const isInstalled = await isBackendInstalled(
        selectedBackend,
        selectedVersion
      )
      if (!isInstalled) {
        logger.info(`Final check: Installing backend ${backendString}`)
        await this.ensureBackendReady(selectedBackend, selectedVersion)
        logger.info(`Successfully installed backend: ${backendString}`)
      } else {
        logger.info(
          `Final check: Backend ${backendString} is already installed`
        )
      }
    } catch (error) {
      logger.error(
        `Failed to ensure backend ${backendString} installation:`,
        error
      )
      throw error // Re-throw as this is critical
    }
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
   * Returns the SHARED models root for both llama.cpp providers
   * (turboquant + upstream). Always `<jan>/llamacpp/models`, regardless of
   * which provider is calling. The turboquant extension already writes
   * GGUFs here; the upstream extension reads/writes the same tree so that
   * a single download serves both engines. Backend binaries and provider
   * config remain isolated per-provider under `<jan>/<providerId>/`.
   */
  async getModelsRootPath(): Promise<string> {
    return await joinPath([
      await getJanDataFolderPath(),
      MODELS_PROVIDER_ROOT,
      'models',
    ])
  }

  override async onUnload(): Promise<void> {
    // Terminate all active sessions

    // Clean up validation event listeners
    if (this.unlistenValidationStarted) {
      this.unlistenValidationStarted()
    }
    if (this.unlistenAutoIncreaseCtx) {
      this.unlistenAutoIncreaseCtx()
    }
    if (this.unlistenCoreSettingsChanged) {
      this.unlistenCoreSettingsChanged()
    }
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
      // setup; any updateSettings calls (e.g. BOM migration) should
      // only touch in-memory config without triggering downloads.
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
    this.config[key] = value

    // Mutual exclusivity between DFlash and MTP speculative-decoding modes.
    // The UI (`$providerName.tsx`) owns persistence of both keys via
    // writeSetting; this keeps the in-memory config consistent as
    // defense-in-depth so a stale sibling flag can't survive into the next
    // settings import the core loads with.
    if (key === 'dflash' && value) {
      this.config.mtp = false
    } else if (key === 'mtp' && value) {
      this.config.dflash = false
    }

    if (key === 'version_backend') {
      const valueStr = value as string
      // Async logic wrapped in IIFE since onSettingUpdate is void
      ;(async () => {
        try {
          // "Latest <variant>" dropdown entries carry a `latest/<backend>`
          // sentinel (they are listed statically, even offline). Resolve the
          // sentinel to the newest concrete release tag now, then route
          // through updateBackend() so the resolved tag is downloaded,
          // persisted, and reflected back into the dropdown selection.
          if (valueStr.startsWith('latest/')) {
            const backendId = valueStr.slice('latest/'.length).trim()
            const resolved = await this.resolveLatestBackendString(backendId)
            if (!resolved) {
              logger.error(
                `Could not resolve the latest release for '${backendId}' — the ggml-org release stream is unreachable. Backend left unchanged.`
              )
              this.config.version_backend = previousVersionBackend ?? ''
              return
            }
            await this.updateBackend(resolved)
            return
          }

          const currentStored = this.getStoredBackendType() || undefined
          const result = await handleSettingUpdate(key, valueStr, currentStored)

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
   * Resolves a "Latest <variant>" sentinel backend id (e.g.
   * `win-cuda-13.3-x64`) to a concrete `<tag>/<backend>` string by looking
   * up the newest release tag from the ggml-org/llama.cpp release stream.
   * Returns `null` when the release stream is unreachable or the variant is
   * not present in the latest release assets.
   */
  private async resolveLatestBackendString(
    backend: string
  ): Promise<string | null> {
    try {
      const remote = await fetchRemoteBackends()
      const match = remote.find((b) => b.backend === backend)
      if (match?.version) {
        return `${match.version}/${backend}`
      }
      // ATO-174 (finishes ATO-105): a minor-less CUDA family id
      // (`win-cuda-13-x64` / `win-cuda-12-x64`) never exact-matches the
      // concrete published asset (`win-cuda-13.3-x64`). Resolve it to the
      // newest concrete asset of that major so the manual dropdown's
      // `latest/win-cuda-13-x64` sentinel keeps resolving across minor bumps.
      // `latest/win-rocm-x64` -> `win-rocm-7.14-x64` works the same way.
      const familyConcrete = resolveGpuFamilyConcrete(backend, remote)
      if (familyConcrete) {
        logger.info(
          `[resolveLatestBackendString] resolved GPU family '${backend}' -> ${familyConcrete}`
        )
        return familyConcrete
      }
      logger.warn(
        `[resolveLatestBackendString] '${backend}' not found in latest release assets`
      )
    } catch (err) {
      logger.warn(
        `[resolveLatestBackendString] Failed to fetch latest release for '${backend}': ${
          err instanceof Error ? err.message : err
        }`
      )
    }
    return null
  }

  /**
   * Returns the newest locally-installed version of a backend family
   * (e.g. `win-cuda-12.4-x64`) as a `<version>/<backend>` string, or `null`
   * when no version of that family is installed. Used as the offline
   * fallback for "Latest <variant>" selections when the ggml-org release
   * stream is unreachable / rate-limited — better to hot-swap to the newest
   * copy the user already has than to dead-end with an error.
   *
   * Version tags are ggml-org build numbers (`b9310`, `b9284`, …); we sort
   * by the trailing integer so `b9310` ranks above `b9284`.
   */
  /**
   * Resolves `p`, but never waits longer than `ms`. On timeout — or if `p`
   * rejects — resolves to `fallback`. Used to cap the ggml-org release lookup
   * in `downloadManualBackend()`: that lookup is routed through the Tauri
   * HTTP layer (reqwest), where a stalled TCP/TLS connection can outlive
   * `fetchRemoteBackends()`'s own JS `AbortController`, leaving the awaiting
   * promise pending forever. The dangling `p` is allowed to settle in the
   * background; we simply stop waiting on it.
   */
  private withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
      p.catch(() => fallback),
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ])
  }

  private async newestInstalledOfFamily(
    backendId: string
  ): Promise<string | null> {
    try {
      const installed = await getLocalInstalledBackends()
      // ATO-174: a minor-less CUDA family id (`win-cuda-13-x64`) matches any
      // installed concrete minor of that major (`win-cuda-13.3-x64`), so the
      // offline fallback still finds a locally-installed CUDA copy when the
      // dropdown sentinel is the family id. Non-CUDA / concrete ids keep the
      // exact match.
      const sameFamily = installed.filter((b) => {
        const bn = stripBom(b.backend)
        return bn === backendId || isConcreteOfGpuFamily(backendId, bn)
      })
      if (sameFamily.length === 0) return null
      const buildNumber = (v: string): number => {
        const m = /(\d+)/.exec(stripBom(v))
        return m ? parseInt(m[1], 10) : 0
      }
      sameFamily.sort((a, b) => buildNumber(b.version) - buildNumber(a.version))
      // Return the *concrete* installed backend id, not the requested family
      // id — `${version}/win-cuda-13-x64` would build a 404 download URL.
      // For an exact (non-family) request `sameFamily[0].backend === backendId`.
      return `${stripBom(sameFamily[0].version)}/${stripBom(sameFamily[0].backend)}`
    } catch (err) {
      logger.warn(`newestInstalledOfFamily('${backendId}') failed:`, err)
      return null
    }
  }

  /**
   * Drives a manual "Latest <variant>" dropdown selection (sentinel
   * `latest/<backend>`) through the same download → hot-swap → completed
   * dialog the "Find optimal backend" button uses — but triggered by hand.
   *
   * The whole flow is keyed on the sentinel string so the globally-mounted
   * `<BackendUpdater />` dialog (a separate `useBackendUpdater` instance) can
   * follow it via Tauri events alone:
   *   1. Emit `onManualBackendDownloading` immediately so the dialog opens in
   *      its spinning "downloading" state the instant the user picks a variant
   *      — no dead air while we resolve the release tag over the (sometimes
   *      slow) network.
   *   2. Resolve the concrete `<tag>/<backend>`: prefer the newest ggml-org
   *      release; if that stream is unreachable / rate-limited, fall back to
   *      the newest copy of this family already installed locally.
   *   3. Download only when the resolved target is NOT already installed —
   *      an already-installed pick just hot-swaps (no redundant fetch).
   *   4. `onBackendDownloadFinished` advances the dialog to "hot-swapping",
   *      then `applyBackendLive()` unloads running models, persists the
   *      resolved `version_backend` (emitting `settingsChanged` so the
   *      dropdown reflects the concrete tag), and dispatches
   *      `app:backend-hotswapped` which the dialog turns into its green
   *      "completed" state.
   *
   * Throws (after emitting `onManualBackendFailed` to dismiss the dialog)
   * when the target can be neither resolved online nor satisfied from a local
   * install, so the caller can surface a toast.
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

    // 1. Instant feedback: open the global recommendation dialog straight
    //    into its "downloading" spinner via a dedicated event the hook turns
    //    into `recommendation = payload` + `phase = 'downloading'` in a single
    //    handler. Going through `onBetterBackendDetected` + a separate
    //    `onBackendDownloadStarted` would race (the started handler reads a
    //    not-yet-committed `recommendation`) and leave the dialog stuck on
    //    the "recommend" confirm screen. The payload is keyed on the sentinel
    //    so the later finish / hot-swap events line up.
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
      // 2. Resolve a concrete <tag>/<backend>: ggml-org latest first, then
      //    fall back to the newest locally-installed copy of this family.
      //    fetchRemoteBackends() now bounds itself at ~15s (connectTimeout +
      //    AbortController) and routes through the configured proxy, so this
      //    outer cap is only a last-resort safety net against a wedged
      //    promise. It MUST sit comfortably above that 15s budget — an 8s cap
      //    here would preempt a slow-but-valid proxied lookup and force
      //    backends with no local copy (e.g. win-vulkan-x64) to dead-end even
      //    though GitHub would have answered in time.
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
              `downloadManualBackend: ggml-org unreachable/slow for '${backendId}', falling back to newest installed ${concrete}`
            )
          }
        }
      } else {
        concrete = sentinel
      }

      if (!concrete) {
        // ATO-174: actionable dead-end message. The backend manifest stream
        // (raw.githubusercontent.com) is unreachable/slow and there is no
        // local copy of this backend family to fall back to. Point the user
        // at the concrete remedies instead of a bare failure.
        throw new Error(
          `Could not download the ${friendlyBackendLabel(backendId)} backend: the backend manifest stream (raw.githubusercontent.com) is unreachable or slow, and no version of this backend is installed locally. Check your connection/proxy (Settings → Proxy) and try again, or install the backend from a downloaded archive via "Install backend from file".`
        )
      }

      // 3. Download only if the resolved target isn't already on disk.
      const [tag, btype] = concrete.split('/')
      const alreadyInstalled = await isBackendInstalled(btype, tag)
      if (alreadyInstalled) {
        logger.info(
          `downloadManualBackend: ${concrete} already installed — switching without download`
        )
      } else {
        logger.info(`downloadManualBackend: downloading ${concrete}`)
        await this.downloadAndInstallBackend(concrete)
      }

      // 4. Advance the dialog to "hot-swapping" (no-op if the inner
      //    download already emitted a concrete finish that moved us there).
      if (events && typeof events.emit === 'function') {
        events.emit(AppEvent.onBackendDownloadFinished, {
          backend: dialogKey,
          status: 'completed',
          provider: this.providerId,
          backendId,
        })
      }

      // 5. Live hot-swap: unload models, persist version_backend (emits
      //    settingsChanged → dropdown updates), dispatch app:backend-hotswapped
      //    (→ dialog "completed"). updateBackend()'s own ensureBackendReady()
      //    is a no-op here since the backend is now installed.
      await this.applyBackendLive(concrete)
      logger.info(`downloadManualBackend: applied ${concrete} live`)
    } catch (err) {
      logger.error('downloadManualBackend failed:', err)
      // Dismiss the dialog cleanly (back to idle) rather than dropping into
      // the "recommend" confirm screen a generic `failed` download event
      // would trigger. The caller surfaces the error toast.
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

  override async get(modelId: string): Promise<modelInfo | undefined> {
    const modelPath = await joinPath([await this.getModelsRootPath(), modelId])
    const path = await joinPath([modelPath, 'model.yml'])

    if (!(await fs.existsSync(path))) return undefined

    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path,
    })

    const isEmbedding = await this.resolveEmbeddingConfig(modelId, modelConfig)

    return {
      id: modelId,
      name: modelConfig.name ?? modelId,
      quant_type: undefined, // TODO: parse quantization type from model.yml or model.gguf
      providerId: this.provider,
      port: 0, // port is not known until the model is loaded
      sizeBytes: modelConfig.size_bytes ?? 0,
      embedding: isEmbedding,
    } as modelInfo
  }

  /**
   * Checks if embedding status is known. If not, reads GGUF, detects it,
   * and updates the model.yml for future performance.
   */
  private async resolveEmbeddingConfig(
    modelId: string,
    modelConfig: ModelConfig
  ): Promise<boolean> {
    // Fast exit: if explicitly set in config, return it
    if (typeof modelConfig.embedding === 'boolean') {
      return modelConfig.embedding
    }

    // Migration logic: Detect from GGUF
    let isEmbedding = false
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const fullModelPath = await joinPath([
        janDataFolderPath,
        modelConfig.model_path,
      ])

      if (await fs.existsSync(fullModelPath)) {
        const metadata = await readGgufMetadata(fullModelPath)
        isEmbedding = isEmbeddingGguf(metadata.metadata)
      }
    } catch (e) {
      // If GGUF read fails, default to false but log it
      logger.warn(`Failed to check metadata for ${modelId}`, e)
      return false
    }

    // Persist the result back to model.yml so we don't read GGUF next time
    try {
      const configPath = await joinPath([
        await this.getModelsRootPath(),
        modelId,
        'model.yml',
      ])

      // Update the local object
      modelConfig.embedding = isEmbedding

      // Write to disk
      await invoke<void>('write_yaml', {
        data: modelConfig,
        savePath: configPath,
      })
    } catch (e) {
      logger.warn(`Failed to update config for ${modelId}`, e)
    }

    return isEmbedding
  }

  /**
   * Which modality a model's mmproj carries, cached in model.yml.
   *
   * Mirrors `resolveEmbeddingConfig`: read the projector GGUF once, then never
   * again. Without the cache this would parse a multi-hundred-megabyte file on
   * every `list()`.
   */
  private async resolveProjectorKind(
    modelId: string,
    modelConfig: ModelConfig
  ): Promise<{ vision: boolean; audio: boolean }> {
    if (
      typeof modelConfig.projector_vision === 'boolean' &&
      typeof modelConfig.projector_audio === 'boolean'
    ) {
      return {
        vision: modelConfig.projector_vision,
        audio: modelConfig.projector_audio,
      }
    }

    // Default matches the behaviour that predates this method: an unreadable
    // projector stays a vision projector rather than losing its capability.
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
      return kind
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

    return kind
  }

  /**
   * Bring up the voice model, reusing a live session when there is one.
   *
   * Loaded with `bypassAutoUnload` so it runs *alongside* the user's chat model
   * rather than evicting it — dictation that silently unloaded the model you
   * were talking to would be a nasty surprise. The matching exclusion in the
   * core's auto-unload keeps it alive when the next chat model loads.
   */
  async ensureTranscriptionModel(
    bypassAutoUnload: boolean = true
  ): Promise<SessionInfo> {
    const existing = await this.resolveSession(TRANSCRIPTION_MODEL_ID)
    if (existing) {
      this.touchTranscriptionIdleTimer()
      return existing
    }

    const installed = await this.list()
    if (!installed.some((model) => model.id === TRANSCRIPTION_MODEL_ID)) {
      const error = new Error('The voice model is not installed.') as Error & {
        code?: string
      }
      error.code = ERR_TRANSCRIPTION_MODEL_MISSING
      throw error
    }

    // `bypassAutoUnload: false` lets the ordinary auto-unload evict the chat
    // model first — the escape hatch for machines that cannot hold both.
    const sInfo = await this.load(
      TRANSCRIPTION_MODEL_ID,
      { ...TRANSCRIPTION_LOAD_OVERRIDES } as Partial<LlamacppConfig>,
      false,
      bypassAutoUnload
    )

    await this.assertAudioModality(sInfo)
    this.touchTranscriptionIdleTimer()
    return sInfo
  }

  /**
   * Confirm the loaded server really exposes an audio encoder.
   *
   * A *missing* `audio` key is treated as unknown and allowed through: older
   * builds do not report modalities at all, and the first real segment will
   * give a much clearer error than a spurious refusal here. Only an explicit
   * `false` is fatal.
   */
  private async assertAudioModality(sInfo: SessionInfo): Promise<void> {
    try {
      const response = await globalThis.fetch(
        `http://localhost:${sInfo.port}/props`,
        { headers: { Authorization: `Bearer ${sInfo.api_key}` } }
      )
      if (!response.ok) return
      const props = (await response.json()) as {
        modalities?: { audio?: boolean }
      }
      if (props?.modalities?.audio === false) {
        const error = new Error(
          "This llama.cpp build cannot run the voice model's audio encoder."
        ) as Error & { code?: string }
        error.code = ERR_TRANSCRIPTION_UNSUPPORTED
        throw error
      }
    } catch (e) {
      if ((e as { code?: string })?.code === ERR_TRANSCRIPTION_UNSUPPORTED) {
        throw e
      }
      // A probe failure is not evidence of anything; let the first segment
      // decide.
      logger.warn('Could not read /props for the voice model', e)
    }
  }

  /** Keep the voice model alive while dictation is in use. */
  touchTranscriptionIdleTimer(): void {
    if (this.transcriptionIdleTimer) {
      clearTimeout(this.transcriptionIdleTimer)
    }
    this.transcriptionIdleTimer = setTimeout(() => {
      this.transcriptionIdleTimer = undefined
      void this.unload(TRANSCRIPTION_MODEL_ID).catch(() => {})
    }, TRANSCRIPTION_IDLE_UNLOAD_MS)
  }

  /** Drop the voice model now, e.g. when the user removes it. */
  async releaseTranscriptionModel(): Promise<void> {
    if (this.transcriptionIdleTimer) {
      clearTimeout(this.transcriptionIdleTimer)
      this.transcriptionIdleTimer = undefined
    }
    await this.unload(TRANSCRIPTION_MODEL_ID).catch(() => {})
  }

  // Implement the required LocalProvider interface methods
  override async list(): Promise<modelInfo[]> {
    const modelsDir = await this.getModelsRootPath()
    if (!(await fs.existsSync(modelsDir))) {
      await fs.mkdir(modelsDir)
    }

    await this.migrateLegacyModels()

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
      const isEmbedding = await this.resolveEmbeddingConfig(
        modelId,
        modelConfig
      )

      // An mmproj is not automatically a *vision* projector: Voxtral's is a
      // Whisper-style audio encoder. Ask the projector which it is.
      const capabilities: string[] = []
      if (modelConfig.mmproj_path) {
        const projector = await this.resolveProjectorKind(modelId, modelConfig)
        if (projector.vision) capabilities.push('vision')
        if (projector.audio) capabilities.push('audio_to_text')
      }

      // Broken-link detection: flag a missing weights file so the UI marks it and auto-start skips it.
      const resolvedPath = await this.resolveModelPath(
        janDataFolderPath,
        modelConfig.model_path
      )
      const missing = resolvedPath
        ? !(await fs.existsSync(resolvedPath).catch(() => true))
        : false

      const modelInfo = {
        id: modelId,
        name: modelConfig.name ?? modelId,
        quant_type: undefined, // TODO: parse quantization type from model.yml or model.gguf
        providerId: this.provider,
        port: 0, // port is not known until the model is loaded
        sizeBytes: modelConfig.size_bytes ?? 0,
        embedding: isEmbedding,
        capabilities: capabilities.length > 0 ? capabilities : undefined,
        source: (modelConfig as { source?: string }).source,
        missing,
        path: resolvedPath,
      } as modelInfo
      modelInfos.push(modelInfo)
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

  private async migrateLegacyModels() {
    // Attempt to migrate only once
    if (localStorage.getItem('cortex_models_migrated') === 'true') return

    const janDataFolderPath = await getJanDataFolderPath()
    const modelsDir = await joinPath([janDataFolderPath, 'models'])
    if (!(await fs.existsSync(modelsDir))) return

    // DFS
    let stack = [modelsDir]
    while (stack.length > 0) {
      const currentDir = stack.pop()

      const files = await fs.readdirSync(currentDir)
      for (const child of files) {
        try {
          const childPath = await joinPath([currentDir, child])
          const stat = await fs.fileStat(childPath)
          if (
            files.some((e) => e.endsWith('model.yml')) &&
            !child.endsWith('model.yml')
          )
            continue
          if (!stat.isDirectory && child.endsWith('.yml')) {
            // check if model.yml exists
            const modelConfigPath = child
            if (await fs.existsSync(modelConfigPath)) {
              const legacyModelConfig = await invoke<{
                files: string[]
                model: string
              }>('read_yaml', {
                path: modelConfigPath,
              })
              const legacyModelPath = legacyModelConfig.files?.[0]
              if (!legacyModelPath) continue
              // Normalize Windows '\' to '/' so the id matches the catalog
              let modelId = currentDir
                .slice(modelsDir.length + 1)
                .replace(/\\/g, '/')

              modelId =
                modelId !== 'imported'
                  ? modelId.replace(/^(cortex\.so|huggingface\.co)[\/\\]/, '')
                  : (await basename(child)).replace('.yml', '')

              const modelName = legacyModelConfig.model ?? modelId
              const configPath = await joinPath([
                await this.getModelsRootPath(),
                modelId,
                'model.yml',
              ])
              if (await fs.existsSync(configPath)) continue // Don't reimport

              // this is relative to Jan's data folder
              const modelDir = `${MODELS_PROVIDER_ROOT}/models/${modelId}`

              let size_bytes = (
                await fs.fileStat(
                  await joinPath([janDataFolderPath, legacyModelPath])
                )
              ).size

              const modelConfig = {
                model_path: legacyModelPath,
                mmproj_path: undefined, // legacy models do not have mmproj
                name: modelName,
                size_bytes,
              } as ModelConfig
              await fs.mkdir(await joinPath([janDataFolderPath, modelDir]))
              await invoke<void>('write_yaml', {
                data: modelConfig,
                savePath: configPath,
              })
              continue
            }
          }
        } catch (error) {
          console.error(`Error migrating model ${child}:`, error)
        }
      }

      // otherwise, look into subdirectories
      const children = await fs.readdirSync(currentDir)
      for (const child of children) {
        // skip files
        const dirInfo = await fs.fileStat(child)
        if (!dirInfo.isDirectory) {
          continue
        }

        stack.push(child)
      }
    }
    localStorage.setItem('cortex_models_migrated', 'true')
  }

  /**
   * Manually installs a supported backend archive from a local file.
   *
   * Still unpacked by this process: the core has no route that installs a pack
   * from a local archive (its install route only downloads). The pack lands in
   * the same `backends/<version>/<backend>` tree the core scans, so the core
   * picks it up on its next listing or load.
   */
  async installBackend(path: string): Promise<void> {
    // Match prefix (optional), llama, main (optional), version (b####-hash),
    // optional cudart-llama, bin, backend details
    // Examples:
    // - k_llama-main-b4314-09c61e1-bin-win-cuda-12.8-x64-avx2.zip
    // - ik_llama-main-b4314-09c61e1-cudart-llama-bin-win-cuda-12.8-x64-avx512.zip
    // - llama-b7037-bin-win-cuda-12.4-x64.zip (legacy format)
    const re =
      /^(.+?[-_])?llama(?:-main)?-(b\d+(?:-[a-f0-9]+)?)(?:-cudart-llama)?-bin-(.+?)\.(?:tar\.gz|zip)$/

    const archiveName = await basename(path)
    logger.info(`Installing backend from path: ${path}`)

    if (
      !(await fs.existsSync(path)) ||
      (!path.endsWith('tar.gz') && !path.endsWith('zip'))
    ) {
      logger.error(`Invalid path or file ${path}`)
      throw new Error(`Invalid path or file ${path}`)
    }

    const match = re.exec(archiveName)

    if (!match) {
      throw new Error(
        `Failed to parse archive name: ${archiveName}. Expected format: [Optional prefix-]llama-<version>-bin-<backend>.(tar.gz|zip)`
      )
    }

    const [, prefix, version, backend] = match

    if (!version || !backend) {
      throw new Error(`Invalid backend archive name: ${archiveName}`)
    }

    // Include prefix in the backend identifier if present
    const rawBackendIdentifier = prefix ? `${prefix}${backend}` : backend

    // ATO-233: normalize ggml-org Ubuntu asset names (ubuntu-*) to the
    // internal linux-* ids used throughout the extension. ggml-org tarballs
    // are named `llama-bXXXX-bin-ubuntu-{vulkan,}-x64.tar.gz` on Linux, but
    // the extension stores backends under `linux-vulkan-x64` / `linux-cpu-x64`
    // so that backend resolution — here and in the core — finds them by the
    // correct internal id.
    const backendIdentifier =
      IS_LINUX && rawBackendIdentifier.startsWith('ubuntu-')
        ? rawBackendIdentifier.includes('vulkan')
          ? `linux-vulkan-${rawBackendIdentifier.includes('arm64') ? 'arm64' : 'x64'}`
          : `linux-cpu-${rawBackendIdentifier.includes('arm64') ? 'arm64' : 'x64'}`
        : rawBackendIdentifier

    if (backendIdentifier !== rawBackendIdentifier) {
      logger.info(
        `[installBackend] Normalized archive backend name '${rawBackendIdentifier}' → '${backendIdentifier}'`
      )
    }

    logger.info(
      `Detected prefix: ${prefix || 'none'}, version: ${version}, backend: ${backendIdentifier}`
    )

    const backendDir = await getBackendDir(backendIdentifier, version)

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

    const newBackendString = `${version}/${backendIdentifier}`

    try {
      await this.configureBackends()

      // Auto-select the newly installed backend
      const effectiveBackendType = await mapOldBackendToNew(backendIdentifier)
      this.setStoredBackendType(effectiveBackendType)
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
   * Update a model with new information.
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
     * first shard and finds the rest by their published file names. Fetching
     * the one file the catalog entry points at left the user with a model that
     * could never load, so pull the whole set, under those names.
     *
     * Per-file hash/size from `opts` describe the single file that was picked
     * and say nothing about its siblings — they are left off, and completeness
     * is enforced at load time against the shard set itself.
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
          resumeDownload ?? false
        )

        // If we reach here, download completed successfully (including validation)
        // The downloadFiles function only returns successfully if all files downloaded AND validated
        events.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
          modelId,
          downloadType: 'Model',
        })
      } catch (error) {
        const errorMessage = formatLoadError(error)

        // Check if this is a cancellation
        const isCancellationError =
          errorMessage.includes('Download cancelled') ||
          errorMessage.includes('Validation cancelled') ||
          errorMessage.includes('Hash computation cancelled') ||
          errorMessage.includes('cancelled') ||
          errorMessage.includes('aborted')

        // Check if this is a validation failure
        const isValidationError =
          errorMessage.includes('Hash verification failed') ||
          errorMessage.includes('Size verification failed') ||
          errorMessage.includes('Failed to verify file')

        // Classify before logging: the extension logger writes through to the
        // Rust logger, where an `error` becomes a Sentry event. Logging first
        // meant every user who pressed Cancel filed a crash report — and since
        // the model id is part of the message, a separate issue per model.
        if (!isCancellationError) {
          logger.error('Error downloading model:', modelId, errorMessage)
        }

        if (isCancellationError) {
          logger.info('Download cancelled for model:', modelId)
          // Emit download stopped event instead of error
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

          // Emit validation failure event
          events.emit(DownloadEvent.onModelValidationFailed, {
            modelId,
            downloadType: 'Model',
            error: errorMessage,
            reason: 'validation_failed',
          })
        } else {
          // Regular download error
          events.emit(DownloadEvent.onFileDownloadError, {
            modelId,
            downloadType: 'Model',
            error: errorMessage,
          })
        }
        throw error
      }
    }

    // Validate GGUF files
    const janDataFolderPath = await getJanDataFolderPath()
    const fullModelPath = await joinPath([janDataFolderPath, modelPath])
    let isEmbedding = false

    try {
      // Validate main model file
      const modelMetadata = await readGgufMetadata(fullModelPath)
      logger.info(
        `Model GGUF validation successful: version ${modelMetadata.version}, tensors: ${modelMetadata.tensor_count}`
      )

      // Embedding weights are usable, but only in embedding mode: handed to
      // the chat path they abort llama.cpp on an assertion.
      isEmbedding = isEmbeddingGguf(modelMetadata.metadata)

      // Validate mmproj file if present
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
    // the path it failed on are both lost by the time the toast renders — which
    // is why every import failure on Windows read "unknown error" and nothing
    // reached the log (issue #256). Name each step on the way out.
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

    // Calculate file sizes. A sharded model is the sum of its parts; quoting
    // only the first shard would advertise a 150 GB model as a few megabytes.
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

    // TODO: add name as import() argument
    // TODO: add updateModelConfig() method
    const modelConfig = {
      model_path: modelPath,
      mmproj_path: mmprojPath,
      name: modelId,
      size_bytes,
      // `model_sha256` / `model_size_bytes` are per-file expectations checked
      // against `model_path` at load. For a shard set they would describe the
      // whole download, not the first shard, and every load would report a
      // "truncated file" — so they are only recorded for single-file models.
      ...(isSharded
        ? {}
        : {
            model_sha256: opts.modelSha256,
            model_size_bytes: opts.modelSize,
          }),
      mmproj_sha256: opts.mmprojSha256,
      mmproj_size_bytes: opts.mmprojSize,
      embedding: isEmbedding,
      ...(importSource ? { source: importSource } : {}),
    } as ModelConfig
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
      // Both llama.cpp providers list the same GGUF dir, so the web-app
      // cannot tell from `modelId` alone which engine imported the file.
      provider: this.provider,
      modelPath,
      mmprojPath,
      size_bytes,
      model_sha256: opts.modelSha256,
      model_size_bytes: opts.modelSize,
      mmproj_sha256: opts.mmprojSha256,
      mmproj_size_bytes: opts.mmprojSize,
      embedding: isEmbedding,
      source: importSource,
    })
  }

  /**
   * Whether the given model id is a Gemma 4 MTP-capable target (31B / 26B-A4B).
   * Used by the provider settings UI to decide between the Gemma download path
   * and the Qwen built-in-MTP path / unsupported dialog.
   */
  async checkGemmaMtpSupport(modelId: string): Promise<boolean> {
    return checkGemmaMtpSupport(modelId)
  }

  /**
   * Whether an installed Qwen GGUF contains an embedded MTP/NextN head.
   * Capability comes from the canonical GGUF metadata rather than the local
   * model id, which may be derived from a filename that omits "MTP".
   */
  async checkEmbeddedMtpSupport(modelId: string): Promise<boolean> {
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
      const gguf = await readGgufMetadata(modelPath)
      return hasEmbeddedMtp(gguf.metadata)
    } catch (error) {
      logger.warn(
        `Failed to inspect embedded MTP metadata for "${modelId}": ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return false
    }
  }

  /**
   * Ensure the Gemma 4 MTP draft head GGUF is present next to the target model
   * and recorded in its `model.yml` (`mtp_draft_path`). Mirrors the MLX
   * `ensureDraftDownloaded` flow: idempotent — if the head is already on disk
   * and referenced in `model.yml`, it is a no-op.
   *
   * @param modelId A Gemma 4 31B or 26B-A4B target model id.
   * @throws if the model id is not a Gemma 4 MTP target.
   */
  async ensureGemmaMtpDraft(modelId: string): Promise<void> {
    const draft: GemmaMtpDraft | null = resolveGemmaMtpDraft(modelId)
    if (!draft) {
      throw new Error(
        `Model "${modelId}" is not a Gemma 4 MTP-capable target (31B / 26B-A4B).`
      )
    }

    const janDataFolderPath = await getJanDataFolderPath()
    const modelsRoot = await this.getModelsRootPath()
    const configPath = await joinPath([modelsRoot, modelId, 'model.yml'])
    if (!(await fs.existsSync(configPath))) {
      throw new Error(`Model ${modelId} is not installed`)
    }

    // Path relative to Jan's data folder (kept relative in model.yml, matching
    // how `model_path` / `mmproj_path` are stored).
    const relativeDraftPath = `${MODELS_PROVIDER_ROOT}/models/${modelId}/mtp-draft.gguf`
    const absoluteDraftPath = await joinPath([
      janDataFolderPath,
      relativeDraftPath,
    ])

    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: configPath,
    })

    // Already downloaded + referenced → nothing to do.
    if (
      modelConfig.mtp_draft_path === relativeDraftPath &&
      (await fs.existsSync(absoluteDraftPath))
    ) {
      return
    }

    if (!(await fs.existsSync(absoluteDraftPath))) {
      const downloadItem: DownloadItem = {
        url: gemmaMtpDraftUrl(draft),
        save_path: relativeDraftPath,
        proxy: getProxyConfig(),
        sha256: draft.draftSha256,
        size: draft.draftSize,
        model_id: modelId,
      }
      const onProgress = (transferred: number, total: number) => {
        events.emit(DownloadEvent.onFileDownloadUpdate, {
          modelId,
          percent: total > 0 ? transferred / total : 0,
          size: { transferred, total },
          downloadType: 'Model',
        })
      }
      const downloadManager = window.core.extensionManager.getByName(
        '@janhq/download-extension'
      )
      await downloadManager.downloadFiles(
        [downloadItem],
        this.createDownloadTaskId(`${modelId}-mtp-draft`),
        onProgress,
        false
      )
      events.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
        modelId,
        downloadType: 'Model',
      })
    }

    // Record the head in model.yml so the core's load can resolve it.
    const updatedConfig = {
      ...modelConfig,
      mtp_draft_path: relativeDraftPath,
    } as ModelConfig
    await invoke<void>('write_yaml', {
      data: updatedConfig,
      savePath: configPath,
    })
  }

  /**
   * Whether the given model id is a DFlash-capable target (Qwen3.5-9B,
   * Qwen3.6-27B, Qwen3.6-35B-A3B). Used by the provider settings UI to decide
   * between the download path and the unsupported dialog.
   */
  async checkDflashSupport(modelId: string): Promise<boolean> {
    return checkDflashSupport(modelId)
  }

  /** Available compatible draft quantizations for the selected target model. */
  async listDflashDrafts(modelId: string): Promise<DflashDraft[]> {
    return listDflashDrafts(modelId)
  }

  /**
   * Whether the selected backend binary can accept
   * `--spec-type draft-dflash`. This is separate from model-level support so
   * the UI can explain backend limitations before downloading a draft.
   */
  async checkDflashBackendSupport(): Promise<boolean> {
    const [version, backend] = stripBom(
      this.config.version_backend || ''
    ).split('/')
    if (!version || !backend || version === 'latest') return false
    try {
      const backendPath = await getBackendExePath(backend, version)
      return await this.backendSupportsDflashSpec(backendPath, {})
    } catch (e) {
      logger.warn(
        `Failed to probe DFlash backend support for ${this.config.version_backend}:`,
        e
      )
      return false
    }
  }

  private async backendSupportsDflashSpec(
    backendPath: string,
    envs: Record<string, string>
  ): Promise<boolean> {
    try {
      return await checkSpecTypeSupport(backendPath, DFLASH_SPEC_TYPE, envs)
    } catch (e) {
      logger.warn(
        `Failed to probe llama-server support for ${DFLASH_SPEC_TYPE}:`,
        e
      )
      return false
    }
  }

  /**
   * Ensure the DFlash draft GGUF is present next to the target model and
   * recorded in its `model.yml` (`dflash_draft_path`). Mirrors
   * `ensureGemmaMtpDraft`: idempotent — if the draft is already on disk and
   * referenced in `model.yml`, it is a no-op.
   *
   * @param modelId A DFlash-capable target model id.
   * @param quant Draft quantization selected by the user. Defaults to Q8_0.
   * @throws if the model id is not a DFlash target.
   */
  async ensureDflashDraft(modelId: string, quant?: string): Promise<void> {
    const draft: DflashDraft | null = resolveDflashDraft(modelId, quant)
    if (!draft) {
      throw new Error(
        `Model "${modelId}" does not have a compatible DFlash draft${quant ? ` quantization "${quant}"` : ''}.`
      )
    }

    const janDataFolderPath = await getJanDataFolderPath()
    const modelsRoot = await this.getModelsRootPath()
    const configPath = await joinPath([modelsRoot, modelId, 'model.yml'])
    if (!(await fs.existsSync(configPath))) {
      throw new Error(`Model ${modelId} is not installed`)
    }

    // Path relative to Jan's data folder (kept relative in model.yml, matching
    // how `model_path` / `mmproj_path` are stored).
    const draftSuffix =
      draft.quant === 'Q4_K_M' ? '' : `-${draft.quant.toLowerCase()}`
    const relativeDraftPath = `${MODELS_PROVIDER_ROOT}/models/${modelId}/dflash-draft${draftSuffix}.gguf`
    const absoluteDraftPath = await joinPath([
      janDataFolderPath,
      relativeDraftPath,
    ])

    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: configPath,
    })

    // Already downloaded + referenced → nothing to do.
    if (
      modelConfig.dflash_draft_path === relativeDraftPath &&
      (await fs.existsSync(absoluteDraftPath))
    ) {
      return
    }

    if (!(await fs.existsSync(absoluteDraftPath))) {
      const downloadItem: DownloadItem = {
        url: dflashDraftUrl(draft),
        save_path: relativeDraftPath,
        proxy: getProxyConfig(),
        sha256: draft.draftSha256,
        size: draft.draftSize,
        model_id: modelId,
      }
      const onProgress = (transferred: number, total: number) => {
        events.emit(DownloadEvent.onFileDownloadUpdate, {
          modelId,
          percent: total > 0 ? transferred / total : 0,
          size: { transferred, total },
          downloadType: 'Model',
        })
      }
      const downloadManager = window.core.extensionManager.getByName(
        '@janhq/download-extension'
      )
      await downloadManager.downloadFiles(
        [downloadItem],
        this.createDownloadTaskId(`${modelId}-dflash-draft`),
        onProgress,
        false
      )
      events.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
        modelId,
        downloadType: 'Model',
      })
    }

    // Record the draft in model.yml so the core's load can resolve it.
    const updatedConfig = {
      ...modelConfig,
      dflash_draft_path: relativeDraftPath,
    } as ModelConfig
    await invoke<void>('write_yaml', {
      data: updatedConfig,
      savePath: configPath,
    })
  }

  /**
   * Remove what a failed download left behind — and nothing else.
   *
   * This used to `fs.rm` the whole model directory. That directory is shared
   * between both llama.cpp providers and holds far more than the file being
   * fetched: the mmproj, the DFlash / MTP drafts, the other shards of an
   * already-installed model. One file failing its hash check therefore took
   * the user's working model with it, with no way back but a multi-gigabyte
   * re-download.
   *
   * Only the artifacts of *this* download are removed (the target file plus its
   * `.tmp` / `.url` partials), and the directory itself goes only when nothing
   * else is left in it.
   *
   * @param modelId The model whose directory was being written into
   * @param items The download items this import queued
   */
  private async cleanupFailedDownload(
    modelId: string,
    items: DownloadItem[]
  ): Promise<void> {
    try {
      const janDataFolderPath = await getJanDataFolderPath()

      for (const item of items) {
        // `.tmp` is the in-flight file and `.url` the resume marker, named by
        // the Rust downloader as `<save_path>.tmp` / `<save_path>.url`.
        for (const suffix of ['', '.tmp', '.url']) {
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
    // Cancel any active download task
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
   * extension's backend configuration is not waited for: the load does not use it.
   */
  override async load(
    modelId: string,
    overrideSettings?: Partial<LlamacppConfig>,
    isEmbedding: boolean = false,
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
            isEmbedding,
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
        'llamacpp',
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
  /// training-max ctx and avoid an infinite regenerate→error→bump cycle.
  /// Asked of the core, which reads it from the GGUF without loading the
  /// model, and cached in-memory for the lifetime of the extension.
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
  /// request-scoped done event, and notifies the web-app UI so the Zustand
  /// provider store mirrors the new value (so the next UI interaction keeps
  /// using the expanded window).
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
      // EventEmitter singleton (which can be bypassed when extensions bundle
      // their own copy of `@janhq/core`).
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
    // Prepend provider to make taskId unique across providers. Do NOT
    // truncate at the first '.' - model ids frequently contain a dot early
    // in the name (e.g. "Qwen3.5-9B-...", "Llama-3.1-8B-..."), and truncating
    // there collapsed distinct models onto the same taskId, causing one
    // download's cancellation to silently clobber another's cancel token.
    // The taskId is embedded in a Tauri event name (`download-${taskId}`),
    // and Tauri rejects any character outside [A-Za-z0-9_/:-] — so map the
    // dot (and anything else forbidden) to '_' while keeping the full id.
    return `${this.provider}/${modelId.replace(/[^A-Za-z0-9_/:-]/g, '_')}`
  }

  /**
   * Sanitize a taskId so the downstream `download-extension` (which wraps
   * it in `download-${taskId}` and feeds it to Tauri's `listen()`) does
   * not get rejected by Tauri's event-name validator. Tauri restricts
   * event names to `[A-Za-z0-9_/:-]`. ggml-org Windows backends contain
   * `.` (`win-cuda-12.4-x64`, `win-cuda-13.3-x64`), so we must strip dots
   * out of the backend / version portion before constructing a taskId.
   *
   * The taskId is opaque to downstream consumers — nothing parses it
   * back into `version` / `backend`, so collapsing `.` to `_` is safe.
   * Other forbidden characters get the same treatment for defense in
   * depth.
   */
  private sanitizeForTauriEvent(value: string): string {
    return value.replace(/[^A-Za-z0-9_-]/g, '_')
  }

  /**
   * Ensure the requested `version`/`backend` pack is installed, asking the core
   * to download it when it is not. Returns the pair that is now installed.
   *
   * Strict on purpose: every caller is an explicit backend selection, and a
   * deliberate choice is never silently swapped for another build. At load
   * time the core picks an installed compatible backend on its own when the
   * configured one is missing.
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
      `Backend ${backendKey} could not be downloaded — the ggml-org release ` +
        `stream may be unreachable or that release has no build for your ` +
        `platform. Check your internet connection (Settings → Proxy) and try ` +
        `again later.`
    )
  }

  /**
   * Downloads a backend pack through the core, which fetches it from the
   * signed mirror or the ggml-org CDN and unpacks it into the data folder it
   * owns — together with the cudart companion a Windows CUDA build needs.
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

    // Defense-in-depth (ATO-95): a `latest` tag is an unresolved sentinel —
    // ggml-org has no `latest` release tag, so building a download URL with
    // it always 404s. Callers must resolve the sentinel to a concrete
    // `<tag>/<backend>` (via `resolveLatestBackendString`) before reaching
    // here.
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

    // The task id keeps the shape the progress bar has always listened on. Tauri rejects event
    // names outside `[A-Za-z0-9_/:-]`, and ggml-org backend ids carry dots (`win-cuda-13.3-x64`),
    // so both halves are sanitized. The `llamacpp-backend-` prefix routes the UI's cancel button
    // to `cancelDownload(taskId)` instead of the model-abort path.
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
    // the POST returns. The Rust relay re-emits the core's progress under this name, and its
    // stages (connecting, retrying n/m) too, with zeroed counters: a frame with `stage` goes to
    // the row's status as a `stage` update, never through `reportProgress`. The core's preflight
    // stages come before any byte, and a stage update does not name the row it creates, so a first
    // 0/0 progress update names it after the task id (the id its Cancel routes on).
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
    // Stream via Tauri IPC Channel instead of the intercepted global fetch.
    // tauri_plugin_http overrides window.fetch and routes requests through
    // reqwest, but its ReadableStream bridge may not properly relay SSE chunks
    // back to the webview. Using a dedicated Tauri command + Channel bypasses
    // the plugin entirely.

    const rawChunks: string[] = []
    let streamDone = false
    let streamError: Error | null = null
    let wakeUp: (() => void) | null = null

    const channel = new Channel<{ data: string; done?: boolean }>()
    channel.onmessage = (event: { data: string; done?: boolean }) => {
      logger.info('[stream] chunk received, length:', event.data.length)
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
    logger.info(
      '[stream] invoking stream_local_http, url:',
      url,
      'timeout:',
      timeoutNum
    )

    const requestPromise = invoke<number>('stream_local_http', {
      url,
      headers: headersRecord,
      body,
      timeoutSecs: timeoutNum,
      onChunk: channel,
    })

    requestPromise
      .then((status) => {
        logger.info('[stream] invoke resolved, status:', status)
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

  /// Which device the loaded model actually ran on.
  ///
  /// Parsed from the llama-server startup log by the core and carried on its
  /// session. The web-app needs it for `model_load`: `n_gpu_layers` there is
  /// the requested value — the "offload everything" sentinel on 98.3% of
  /// events — so how many layers reached the GPU, and whether a CUDA build
  /// quietly ran on CPU, was recorded nowhere.
  ///
  /// The core snapshots the device when the server reports ready; there is no
  /// route to re-read it later, so a slow mmap that has not logged
  /// `load_tensors` by then yields `null`.
  ///
  /// Never throws: telemetry must not be able to break a load.
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
   * Everything that must be true before the core loads its first model for us.
   *
   * Two things, both from PLAN.md §3.4 and §2 decision 10, and both once per attachment/settings
   * generation:
   *
   * - the app's settings for this provider are imported, because until they are, this app's copy
   *   is the truth and the core would load with its own defaults instead of the user's;
   * - the hardware numbers the app can measure and the core cannot are injected, because the CUDA
   *   tier a backend is chosen from is decided by exactly those.
   *
   * A conflict blocks the load. Continuing would acknowledge neither side and let the core load
   * with values the user never agreed to, while the settings screen shows the others.
   */
  private async ensureCoreIsReady(): Promise<void> {
    const [values, status] = await Promise.all([
      this.currentSettingValues(),
      coreRuntime.getStatus(),
    ])
    const attachment = status.attached
    if (!attachment?.instance_id || attachment.generation === undefined) {
      throw new Error('Atomic core has no ready attachment generation')
    }
    const key = `${attachment.instance_id}:${attachment.generation}:${stableSettingsFingerprint(values)}`
    if (this.coreReady?.key === key) return await this.coreReady.promise

    const promise = this.prepareCore(values)
    this.coreReady = { key, promise }
    try {
      await promise
    } catch (error) {
      if (this.coreReady?.promise === promise) this.coreReady = undefined
      throw error
    }
  }

  private async prepareCore(values: Record<string, unknown>): Promise<void> {
    let result: Awaited<ReturnType<typeof coreRuntime.importSettings>>
    try {
      result = await coreRuntime.importSettings(values)
    } catch (error) {
      // The control route reports a merge conflict as HTTP 409. Rust preserves the core error
      // envelope, so the conflict data may be in details rather than a successful result body.
      throw new Error(`Atomic core settings import failed: ${coreRuntime.describeCoreError(error)}`)
    }
    if (result.status === 'conflict') {
      throw new Error(
        `Atomic core settings conflict: ${result.conflicts.map((conflict) => conflict.key).join(', ')}`
      )
    }

    await this.enqueueCoreSettingsMirror()

    const info = await getSystemInfo()
    await coreRuntime.sendHardwareOverride({
      gpus: (info?.gpus ?? []) as unknown[],
      ...(info?.cpu?.extensions ? { cpu_extensions: info.cpu.extensions } : {}),
      ...(info?.os_type ? { os_type: info.os_type } : {}),
    })
  }

  private enqueueCoreSettingsMirror(): Promise<void> {
    const mirror = this.coreSettingsMirror.then(() => this.mirrorCoreSettings())
    this.coreSettingsMirror = mirror.catch(() => {})
    return mirror
  }

  private async mirrorCoreSettings(): Promise<void> {
    const snapshot = await coreRuntime.getSettings()
    const persisted = await this.getSettings()
    const mirrored = persisted.map((setting) => {
      if (Object.prototype.hasOwnProperty.call(snapshot.values, setting.key)) {
        setting.controllerProps.value = snapshot.values[setting.key] as never
      }
      return setting
    })
    this.isMirroringCoreSettings = true
    try {
      await this.updateSettings(mirrored)
    } finally {
      this.isMirroringCoreSettings = false
    }
    await coreRuntime.acknowledgeSettings(snapshot.revision)
  }

  /** This provider's settings as the app currently holds them, for the import. */
  private async currentSettingValues(): Promise<Record<string, unknown>> {
    const persisted = await this.getSettings()
    const values: Record<string, unknown> = {}
    for (const setting of persisted) {
      const value = setting.controllerProps?.value
      if (value !== undefined) values[setting.key] = value
    }
    return values
  }

  /**
   * Where a model is served, asked of the core every time.
   *
   * Nothing is cached here: the core reloads a model on its own when a prompt overflows the
   * context window, and the port changes without this extension being asked.
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
    // Requires llamacpp version > b6399
    // Example json returned from server
    // {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}],"created":1758113912,"id":"chatcmpl-UwZwgxQKyJMo7WzMzXlsi90YTUK2BJro","model":"qwen","system_fingerprint":"b1-e4912fc","object":"chat.completion.chunk","prompt_progress":{"total":36,"cache":0,"processed":36,"time_ms":5706760300}}
    // (chunk.prompt_progress?.processed / chunk.prompt_progress?.total) * 100
    // chunk.prompt_progress?.cache is for past tokens already in kv cache
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

    // Check for out-of-context error conditions
    if (completionResponse.choices?.[0]?.finish_reason === 'length') {
      // finish_reason 'length' indicates context limit was hit
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
   * none installed it answers an empty list rather than an error, because there is nothing for the
   * user to fix in Settings yet.
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

  async embed(text: string[]): Promise<EmbeddingResponse> {
    const modelId = 'sentence-transformer-mini'
    const installed = await this.list()
    if (!installed.some((model) => model.id === modelId)) {
      await this.import(modelId, {
        modelPath: 'https://huggingface.co/second-state/All-MiniLM-L6-v2-Embedding-GGUF/resolve/main/all-MiniLM-L6-v2-ggml-model-f16.gguf?download=true',
      })
    }
    await this.ensureCoreIsReady()
    try {
      // The core loads the model when needed and batches the input to fit `ubatch_size`.
      return await coreRuntime.embed(text, this.config?.ubatch_size > 0 ? this.config.ubatch_size : 512) as EmbeddingResponse
    } catch (error) {
      throw new Error(coreRuntime.describeCoreError(error))
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
    // model option is required
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
      const result = await isModelSupported(
        path,
        Number(ctxSize),
        this.config.cache_type_k,
        this.config.cache_type_v
      )
      return result
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
      logger.info('Conversation has images')
      try {
        logger.info(`MMPROJ PATH: ${sessionInfo.mmproj_path}`)
        const metadata = await readGgufMetadata(sessionInfo.mmproj_path)
        logger.info(`mmproj metadata: ${JSON.stringify(metadata.metadata)}`)
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
      console.debug('[TokenCounter:ext] calling /apply-template via invoke')
      const applyResult = await invoke<string>('post_local_http', {
        url: `${baseUrl}/apply-template`,
        headers,
        body: JSON.stringify(tokenizeRequest),
        timeoutSecs: 10,
      })
      const parsedPrompt = JSON.parse(applyResult)
      console.debug(
        '[TokenCounter:ext] /apply-template done, promptLen:',
        parsedPrompt.prompt?.length
      )

      const tokenizeResult = await invoke<string>('post_local_http', {
        url: `${baseUrl}/tokenize`,
        headers,
        body: JSON.stringify({ content: parsedPrompt.prompt }),
        timeoutSecs: 10,
      })
      const dataTokens = JSON.parse(tokenizeResult)
      const textTokens = dataTokens.tokens?.length || 0
      console.debug(
        '[TokenCounter:ext] done, textTokens:',
        textTokens,
        'imageTokens:',
        imageTokens
      )

      return textTokens + imageTokens
    } catch (e) {
      console.warn('[TokenCounter:ext] error in tokenize chain:', String(e))
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

    logger.info(
      `Calculated ${projectionDim} tokens per image, ${imageCount} images total`
    )
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

    logger.warn(
      `Fallback estimation: ${estimatedTokensPerImage} tokens per image, ${imageCount} images total`
    )
    return imageCount * estimatedTokensPerImage - imageCount // remove the lingering <__image__> placeholder token
  }
}
