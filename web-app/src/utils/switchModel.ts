import { toast } from 'sonner'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { readProviderFit } from '@/lib/provider-fit'
import { DEFAULT_CTX_LEN } from '@/lib/context-size'
import { useThreads } from '@/hooks/useThreads'
import { localStorageKey } from '@/constants/localStorage'
import { showModelLoadErrorToast } from '@/containers/ModelLoadErrorToast'
import i18n from '@/i18n/setup'
import type { ServiceHub } from '@/services'
import {
  isKeylessRemoteProvider,
  isSubscriptionProvider,
  registerRemoteProvider,
} from '@/utils/registerRemoteProvider'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'
import {
  isRecoverableModelLoadCode,
  loadBackendFromProvider,
  normalizeModelId,
  classifyModelLoadFailure,
  execBackend,
  gpuOffloadBucket,
  mmprojProjectorType,
  rememberExecBackend,
  modelLoadSource,
  oomSubtype,
  quantFromModelId,
  sanitizeStderrTail,
  shouldCaptureModelLoadSentry,
  shouldEmitModelLoadFailure,
  shouldEmitModelLoadSuccess,
  sizeBucket,
  type RuntimeDeviceSnapshot,
} from '@/lib/telemetry'
import { queuedCapture } from '@/lib/telemetry-queue'
import { ExtensionManager } from '@/lib/extension'
import { captureHandledError } from '@/lib/sentry'
import {
  getProviderTitle,
  MODEL_LOAD_WATCHDOG_MS,
  OPERATION_TIMED_OUT_CODE,
  SERVER_START_WATCHDOG_MS,
  withTimeout,
} from '@/lib/utils'

type ModelSettingEntry = { controller_props?: { value?: unknown } }
type LoadableModel = {
  id: string
  capabilities?: string[]
  settings?: Record<string, ModelSettingEntry>
  /** Scanner that found an imported model (ollama / lmstudio / unsloth / …). */
  source?: string
  /** On-disk size, summed across shards by the engine at import time. */
  sizeBytes?: number
}

function settingNum(
  settings: Record<string, ModelSettingEntry> | undefined,
  key: string
): number | null {
  const value = settings?.[key]?.controller_props?.value
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)))
    return Number(value)
  return null
}

function settingStr(
  settings: Record<string, ModelSettingEntry> | undefined,
  key: string
): string | null {
  const value = settings?.[key]?.controller_props?.value
  return typeof value === 'string' && value ? value : null
}

/**
 * ATO-109: emit the `model_load` telemetry event. Local engines only (cloud
 * providers do not load weights). PII contract: only ids/enums/numbers; the
 * stderr tail is byte-capped and PII-scrubbed by `sanitizeStderrTail`.
 */
/**
 * Ask the engine what the loaded model actually ran on.
 *
 * Resolved through `ExtensionManager` rather than the service hub because
 * only the llama.cpp engines can answer — MLX and foundation-models have no
 * equivalent, and an older bundled extension will not have the method at all,
 * so both degrade to `null`. Never throws: telemetry must not break a load.
 */
async function readRuntimeDevice(
  modelId: string
): Promise<RuntimeDeviceSnapshot | null> {
  try {
    const engines = ExtensionManager.getInstance().listExtensions()
    for (const ext of engines) {
      const reader = (
        ext as unknown as {
          getRuntimeDeviceInfo?: (id: string) => Promise<unknown>
        }
      ).getRuntimeDeviceInfo
      if (typeof reader !== 'function') continue
      const info = await reader.call(ext, modelId)
      if (info) return info as RuntimeDeviceSnapshot
    }
  } catch (err) {
    console.debug('runtime device read failed:', err)
  }
  return null
}

function emitModelLoad(
  status: 'success' | 'failed',
  args: {
    modelId: string
    providerName: string
    durationMs: number
    model?: LoadableModel
    error?: unknown
    isAutoStart?: boolean
    runtimeDevice?: RuntimeDeviceSnapshot | null
  }
): void {
  try {
    const settings = args.model?.settings
    const backend = loadBackendFromProvider(args.providerName)
    // ATO-468: successes were never throttled, so a stop/start oscillation
    // that keeps working emitted without limit. One device produced 62.9% of
    // every `model_load` event in the project.
    if (status === 'success' && !shouldEmitModelLoadSuccess(args.modelId, backend))
      return
    const props: Record<string, unknown> = {
      // NOT `status`. PostHog types a property globally by its observed values,
      // and `api_server_request.status` (an HTTP code) already claimed that
      // name as numeric — so these strings silently read back as null. That is
      // why the "model_load.status is currently empty" note has been sitting on
      // the Models & Errors dashboard: ~42k events of success/failed were
      // unreadable. Keep this name event-specific.
      load_status: status,
      model_id: normalizeModelId(args.modelId),
      backend,
      model_source: modelLoadSource(args.modelId),
      // Where an imported model came from — the scanner that found it
      // (ollama / lmstudio / unsloth / hf cache). Persisted in `model.yml` and
      // already on the store model; `model_source: 'local_disk'` on its own
      // cannot tell an import from a re-load of something downloaded earlier.
      import_source: args.model?.source ?? null,
      // ATO-468: separates loop traffic from loads a user asked for, without
      // any heuristic — the flag is already on the call.
      is_auto_start: args.isAutoStart ?? false,
      load_duration_ms: args.durationMs,
      backend_version: settingStr(settings, 'version_backend'),
      ctx: settingNum(settings, 'ctx_len') ?? settingNum(settings, 'ctx_size'),
      // Under fit the engine sizes the context itself and `ctx` is what the
      // *previous* load settled on (mirrored back from `/props`), not a
      // request. Read from the provider, where the flag lives.
      fit_enabled: readProviderFit(
        useModelProvider.getState().getProviderByName(args.providerName)
      ),
      // The UI setting, i.e. what was *asked for*. 98.3% of events read 100,
      // the "offload everything" sentinel that is set on every model of every
      // engine — including MLX, where the concept does not apply. How many
      // layers actually landed on the GPU is not known here; see ATO-468.
      n_gpu_layers_requested:
        settingNum(settings, 'ngl') ?? settingNum(settings, 'n_gpu_layers'),
      n_gpu_layers:
        settingNum(settings, 'ngl') ?? settingNum(settings, 'n_gpu_layers'),
      size_bucket: sizeBucket(args.model?.sizeBytes),
      // What actually happened, as opposed to what was asked for. This is the
      // field "what share of devices run on GPU versus CPU" is counted on.
      gpu_offload_bucket: gpuOffloadBucket(args.runtimeDevice),
      gpu_layers_offloaded: args.runtimeDevice?.gpu_layers_offloaded ?? null,
      gpu_layers_total: args.runtimeDevice?.total_layers ?? null,
      // The backend that computed, not the build the device downloaded — the
      // distinction `active_backend` never made.
      exec_backend: execBackend(args.runtimeDevice),
      // A CUDA build that cannot find its runtime silently falls back to CPU;
      // without this that is indistinguishable from a healthy CPU load.
      cuda_runtime_missing: args.runtimeDevice?.cuda_runtime_missing ?? null,
      has_device_init_error: Boolean(args.runtimeDevice?.device_init_error),
      is_multimodal:
        (args.model?.capabilities || []).includes('vision') ||
        settingStr(settings, 'mmproj_path') != null,
      device_used: settingStr(settings, 'device'),
    }
    if (status === 'failed') {
      const err = toErrorObject(args.error)
      const haystack = err.details ?? err.message
      const errorCode = err.code ?? null
      // ATO-133: a model stuck in a load crashloop emits the same failure over
      // and over; drop duplicates within the throttle window so event-weighted
      // metrics aren't dominated by a handful of stuck devices.
      if (!shouldEmitModelLoadFailure(args.modelId, errorCode)) return
      // The actual OOM flag, from the same predicate the Sentry severity
      // already uses. On macOS a Metal OOM arrives as
      // `LLAMA_CPP_PROCESS_ERROR` with the cause only in the stderr tail —
      // 2251 events across 124 devices, against 16 carrying `OUT_OF_MEMORY` —
      // so every alert built on `error_code = 'OUT_OF_MEMORY'` was blind to
      // the whole platform.
      const isOom = isOutOfMemoryError(err)
      props.error_code = errorCode
      // Null on 68% of failures, which is why `load_failure_kind` exists.
      props.load_failure_kind = classifyModelLoadFailure(
        errorCode,
        haystack,
        isOom
      )
      props.is_oom = isOom
      // What `oom_subtype` always was: a memory-domain tag written on every
      // failure with a default of 'unknown', not a sign of running out.
      props.memory_domain = oomSubtype(haystack)
      props.oom_subtype = oomSubtype(haystack)
      props.mmproj_projector_type = mmprojProjectorType(haystack)
      props.stderr_tail = sanitizeStderrTail(haystack)
    }
    queuedCapture('model_load', props)
  } catch (telemetryError) {
    console.debug('model_load telemetry failed:', telemetryError)
  }
}

// Local providers whose models are served by on-device engines.
const LOCAL_PROVIDERS = [
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
  'foundation-models',
] as const
type LocalProviderName = (typeof LOCAL_PROVIDERS)[number]

function isLocalEngineProvider(providerName: string): boolean {
  return (LOCAL_PROVIDERS as readonly string[]).includes(providerName)
}

// ATO-270: `doSwitchToModel` has no ceiling on how long it waits for the
// model to load or the proxy server to start — if either step gets stuck on
// an un-timeboxed network call somewhere in backend preparation, the promise
// never settles and the "Starting Server" UI (`serverStatus === 'pending'`)
// hangs forever, with no error and no way to retry. `MODEL_LOAD_WATCHDOG_MS`
// / `SERVER_START_WATCHDOG_MS` (see `@/lib/utils`) are a last-resort safety
// net, not a replacement for fixing the underlying stall: on expiry the
// `catch` block below runs exactly as it would for any other failure
// (status reset, toast, telemetry) instead of leaving the app stuck.
const LOCAL_API_SERVER_START_TIMEOUT_CODE = 'LOCAL_API_SERVER_START_TIMEOUT'

/** Re-tags a `withTimeout` expiry with the ATO-270-specific error code used
 * to force a toast even on auto-start (see `reportModelLoadError`), while
 * leaving every other rejection (a genuine failure, not a timeout) untouched. */
function taggedWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return withTimeout(promise, ms, message).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: string }).code === OPERATION_TIMED_OUT_CODE
    ) {
      (error as { code?: string }).code = LOCAL_API_SERVER_START_TIMEOUT_CODE
    }
    throw error
  })
}

function setLastUsedModel(provider: string, model: string) {
  try {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider, model })
    )
  } catch (error) {
    console.debug('Failed to set last used model in localStorage:', error)
  }
}

// Tail of the switch queue. Every `switchToModel` chains onto this so switches
// run strictly one-at-a-time. Crucially this is a real queue, NOT a
// `while (activeSwitchPromise) await` spin: the spin let *every* waiter wake and
// fall through the moment the in-flight promise resolved, so two switches could
// then run `doSwitchToModel` concurrently — one engine spins up while the other
// `stopAllModels()`-es it away, producing the "turboquant switch briefly
// launched an MLX server, dropped it, failed, then worked on retry" race.
let activeSwitchPromise: Promise<void> | null = null
// Monotonic id of the most recently *enqueued* switch. A queued switch compares
// its own id against this right before doing work; if a newer switch has since
// been enqueued it supersedes this one, so we skip the stale load entirely
// (e.g. an auto-start of the previous model that the user's manual pick already
// replaced — no more wasted engine spawn + teardown).
let switchSeq = 0

// WS2 (Sentry desktop top-10): the ChatInput auto-start effect re-fires whenever
// `serverStatus` / `loadingModel` change, and a failed load flips both — so a
// model that cannot load (e.g. its file was deleted) spins in a tight loop,
// restarting on a fresh port every ~1s and flooding telemetry. We record the
// last auto-start outcome per (provider, model): terminal failures (missing
// model / binary) are never auto-retried, and any other failure is backed off.
// Explicit user switches (dropdown / send) bypass this gate entirely.
type AutoStartFailure = { ts: number; terminal: boolean }
const autoStartFailures = new Map<string, AutoStartFailure>()
const AUTO_START_BACKOFF_MS = 30_000
const TERMINAL_LOAD_CODES = new Set([
  'MODEL_FILE_NOT_FOUND',
  // A partial / corrupt download (ATO-187) won't fix itself on auto-retry —
  // only a manual re-download resolves it, so don't loop the auto-start.
  'MODEL_FILE_CORRUPT',
  // A multi-part GGUF missing shards is the same situation: only fetching the
  // rest of the set fixes it.
  'MODEL_SHARDS_INCOMPLETE',
  'BINARY_NOT_FOUND',
  // The engine build can't parse this model's architecture/format (e.g. a
  // newer qwen3vl GGUF). Retrying loads the same unsupported file — never auto-retry.
  'MODEL_ARCH_NOT_SUPPORTED',
  // ATO-190: the bundled macOS engine requires a newer macOS than the host
  // (missing Metal symbol). This never resolves on retry, so never auto-retry.
  'OS_VERSION_UNSUPPORTED',
])

function autoStartKey(providerName: string, modelId: string): string {
  return `${providerName}::${modelId}`
}

// A user-initiated switch (dropdown pick / send) already drives the engines to
// the requested target, and it changes the selection the moment it starts. The
// ChatInput auto-start effect reacts to that same change, so without this marker
// it re-probes every engine and enqueues a second switch for the identical
// target — which, being enqueued later, supersedes the explicit one and
// downgrades its error reporting to the silent auto-start path.
let pendingExplicitSwitch: string | null = null

export function isExplicitSwitchPending(
  providerName: string,
  modelId: string
): boolean {
  return pendingExplicitSwitch === autoStartKey(providerName, modelId)
}

function clearAutoStartFailure(providerName: string, modelId: string): void {
  autoStartFailures.delete(autoStartKey(providerName, modelId))
}

function recordAutoStartFailure(
  providerName: string,
  modelId: string,
  errorCode: string | null
): void {
  autoStartFailures.set(autoStartKey(providerName, modelId), {
    ts: Date.now(),
    terminal: errorCode != null && TERMINAL_LOAD_CODES.has(errorCode),
  })
  if (autoStartFailures.size > 200) autoStartFailures.clear()
}

/**
 * WS2: whether the automatic (effect-driven) start may attempt loading this
 * model. Returns false when the previous auto-start failed terminally (missing
 * model/binary — never auto-retried) or, for any other failure, while still
 * within the backoff window. A successful load (or an explicit user switch that
 * succeeds) clears the record. Explicit user-initiated switches do NOT call this.
 */
export function shouldAttemptAutoStart(
  providerName: string,
  modelId: string
): boolean {
  if (isExplicitSwitchPending(providerName, modelId)) return false
  const prev = autoStartFailures.get(autoStartKey(providerName, modelId))
  if (!prev) return true
  if (prev.terminal) return false
  return Date.now() - prev.ts >= AUTO_START_BACKOFF_MS
}

/**
 * ATO-63: a failed load (e.g. MLX can't load `lfm2_moe`) raises a persistent
 * `model-load-error` toast. If the user then successfully starts the same model
 * through another backend (llama.cpp), the stale toast keeps hanging, making it
 * look as if nothing loaded. Clear both the toast and the stored error on every
 * successful load so the UI reflects reality.
 */
function clearModelLoadError() {
  toast.dismiss('model-load-error')
  useModelLoad.getState().setModelLoadError(undefined)
}

/**
 * Legacy event name retained for the dormant once-ever Turboquant dialog.
 * Startup detection now feeds the shared chat mismatch prompt instead.
 */
export const TURBOQUANT_OPTIMAL_PROMPT_EVENT = 'turboquant:offer-optimal-backend'

function syncModelSelection(providerName: string, modelId: string) {
  const serverState = useLocalApiServer.getState()

  useModelProvider.getState().selectModelProvider(providerName, modelId)

  serverState.setDefaultModelLocalApiServer({
    model: modelId,
    provider: providerName,
  })
  serverState.setLastServerModels([{ model: modelId, provider: providerName }])

  setLastUsedModel(providerName, modelId)

  useThreads.getState().updateCurrentThreadModel({
    id: modelId,
    provider: providerName,
  })
}

async function isTargetModelAlreadyServing(params: {
  modelId: string
  providerName: string
  serviceHub: ServiceHub
}): Promise<boolean> {
  const { modelId, providerName, serviceHub } = params

  if (isLocalEngineProvider(providerName)) {
    const [serverRunning, providerActive, otherProviderActive] =
      await Promise.all([
        serviceHub.app().getServerStatus().catch(() => false),
        serviceHub.models().getActiveModels(providerName).catch(() => [] as string[]),
        Promise.all(
          LOCAL_PROVIDERS.filter(
            (provider) => provider !== (providerName as LocalProviderName)
          ).map((provider) =>
            serviceHub.models().getActiveModels(provider).catch(() => [] as string[])
          )
        ),
      ])

    return (
      serverRunning &&
      providerActive.length === 1 &&
      providerActive[0] === modelId &&
      otherProviderActive.every((models) => models.length === 0)
    )
  }

  // Cloud provider: already "serving" when the proxy is up, the UI active-model
  // pointer is on this cloud model, and no local engines are loaded.
  const [serverRunning, localEngineModels] = await Promise.all([
    serviceHub.app().getServerStatus().catch(() => false),
    Promise.all(
      LOCAL_PROVIDERS.map((provider) =>
        serviceHub.models().getActiveModels(provider).catch(() => [] as string[])
      )
    ),
  ])

  const activeUiModels = useAppState.getState().activeModels
  const noLocalLoaded = localEngineModels.every((models) => models.length === 0)

  return (
    serverRunning &&
    noLocalLoaded &&
    activeUiModels.length === 1 &&
    activeUiModels[0] === modelId
  )
}

/**
 * Unified model switching function.
 *
 * Ensures only one local model is ever running across both llamacpp and mlx,
 * restarts the Local API Server for the new model, and synchronises all
 * global UI state (dropdown selection, thread model, localStorage, etc.).
 *
 * Serialised: concurrent calls wait for the previous switch to finish so that
 * two callers cannot race against each other (e.g. dropdown + ChatInput effect).
 */
export async function switchToModel(params: {
  modelId: string
  providerName: string
  serviceHub: ServiceHub
  isAutoStart?: boolean
}): Promise<void> {
  // Claim a slot in the queue. `mySeq` lets us detect if a newer switch was
  // enqueued behind us while we waited for earlier ones to finish.
  const mySeq = ++switchSeq
  const prior = activeSwitchPromise

  const isExplicit = !params.isAutoStart
  const explicitKey = autoStartKey(params.providerName, params.modelId)
  if (isExplicit) {
    pendingExplicitSwitch = explicitKey
  }

  const run = async (): Promise<void> => {
    // Supersession: another switch was requested after this one while we were
    // waiting our turn. That later request is the user's real intent, so drop
    // this stale load instead of spinning up an engine the next switch would
    // immediately tear down (root of the MLX-then-drop race on manual picks).
    if (mySeq !== switchSeq) {
      console.log(
        '[switchToModel] Superseded by a newer switch, skipping:',
        params.modelId,
        'provider:',
        params.providerName
      )
      return
    }

    if (await isTargetModelAlreadyServing(params)) {
      const activeModels = await params.serviceHub
        .models()
        .getActiveModels()
        .catch(() => [] as string[])

      useAppState.getState().setServerStatus('running')
      // getActiveModels() is local-engine only; preserve any cloud model that
      // is already "active" in the UI so re-selecting the same cloud target
      // does not wipe out the global active-model state.
      syncActiveModelsFromEngines(activeModels || [])
      syncModelSelection(params.providerName, params.modelId)
      // WS2: the target is healthy — clear any prior auto-start failure record.
      clearAutoStartFailure(params.providerName, params.modelId)
      // ATO-63: the model is up — drop any stale "Failed to load" toast.
      clearModelLoadError()
      console.log(
        '[switchToModel] Target already active, skipping restart:',
        params.modelId,
        'provider:',
        params.providerName
      )
      return
    }

    await doSwitchToModel(params)
  }

  // Chain strictly after any in-flight/queued switch. A prior failure must not
  // break the chain, so swallow it and still run ours.
  const chained = (prior ?? Promise.resolve()).then(run, run)
  activeSwitchPromise = chained
  try {
    await chained
  } finally {
    // Only clear the tail if nobody chained after us; otherwise the later
    // switch owns the tail and must keep the queue intact.
    if (activeSwitchPromise === chained) {
      activeSwitchPromise = null
    }
    // A newer explicit switch owns the marker from here on.
    if (isExplicit && pendingExplicitSwitch === explicitKey) {
      pendingExplicitSwitch = null
    }
  }
}

// The engine needs a beat to settle before the proxy is pointed at it, but the
// previous blind 500ms sleep charged the full budget to every single switch.
// Wait the short floor, then return as soon as the engine reports the model.
const ENGINE_SETTLE_FLOOR_MS = 100
const ENGINE_SETTLE_BUDGET_MS = 500
const ENGINE_SETTLE_POLL_MS = 50

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function settleAfterLocalStart(
  serviceHub: ServiceHub,
  providerName: string,
  modelId: string
): Promise<void> {
  const deadline = Date.now() + ENGINE_SETTLE_BUDGET_MS
  await sleep(ENGINE_SETTLE_FLOOR_MS)

  for (;;) {
    const active = await serviceHub
      .models()
      .getActiveModels(providerName)
      .catch(() => [] as string[])
    if (active?.includes(modelId)) return
    if (Date.now() >= deadline) return
    await sleep(ENGINE_SETTLE_POLL_MS)
  }
}

async function doSwitchToModel(params: {
  modelId: string
  providerName: string
  serviceHub: ServiceHub
  isAutoStart?: boolean
}): Promise<void> {
  const { modelId, providerName, serviceHub, isAutoStart } = params

  const { setServerStatus, setActiveModels, updateLoadingModel } =
    useAppState.getState()
  const serverState = useLocalApiServer.getState()

  // Capture whether the proxy was already up before step 2 tears it down. With
  // auto-start disabled we still keep a manually-started server alive across a
  // switch, but we never stand a new one up on our own for a local model.
  const wasServerRunning = useAppState.getState().serverStatus === 'running'

  const isLocal = isLocalEngineProvider(providerName)
  let loadStartTs = 0
  let modelConfig: LoadableModel | undefined

  // The :1337 proxy is only (re)started for cloud models, when the user opted
  // into auto-start, or when it was already running manually. When it will stay
  // down (local model + auto-start off + not running), never flip the status to
  // 'pending' — otherwise the Local API Server panel briefly renders a
  // "Starting Server" spinner before snapping back to 'stopped'.
  const shouldStartServer =
    !isLocal || serverState.enableOnStartup || wasServerRunning

  const startLocalApiServer = async (): Promise<void> => {
    let actualPort: number | undefined
    try {
      const startServerCall = window.core?.api?.startServer({
        host: serverState.serverHost,
        port: serverState.serverPort,
        prefix: serverState.apiPrefix,
        apiKey: serverState.apiKey,
        trustedHosts: serverState.trustedHosts,
        isCorsEnabled: serverState.corsEnabled,
        isVerboseEnabled: serverState.verboseLogs,
        proxyTimeout: serverState.proxyTimeout,
      }) as Promise<number> | undefined
      actualPort = startServerCall
        ? await taggedWithTimeout(
            startServerCall,
            SERVER_START_WATCHDOG_MS,
            'Timed out waiting for the Local API Server to start.'
          )
        : undefined
    } catch (startErr) {
      const msg =
        startErr instanceof Error ? startErr.message : String(startErr)
      if (!msg.includes('already running')) throw startErr
    }

    console.log('[switchToModel] Server started on port:', actualPort)

    if (actualPort && actualPort !== serverState.serverPort) {
      serverState.setServerPort(actualPort)
    }
    setServerStatus('running')
  }

  setServerStatus(shouldStartServer ? 'pending' : 'stopped')
  updateLoadingModel(true)
  console.log(
    '[switchToModel] Switching to model:',
    modelId,
    'provider:',
    providerName,
    isLocal ? '(local)' : '(cloud)'
  )

  try {
    // 1. Stop every other local model (llamacpp + mlx) so only one model is
    //    ever "active" globally. For a local target the target engine's own
    //    copy is left alone: `startModel` short-circuits on an already-loaded
    //    model, so a switch whose only job is to drop a stray copy in another
    //    provider never kills a server that may be streaming right now.
    if (isLocal) {
      await serviceHub.models().stopAllModelsExcept(modelId, providerName)
      const stillActive = await serviceHub
        .models()
        .getActiveModels(providerName)
        .catch(() => [] as string[])
      setActiveModels(stillActive.filter((m) => m === modelId))
      console.log('[switchToModel] Other local models stopped')
    } else {
      await serviceHub.models().stopAllModels()
      setActiveModels([])
      console.log('[switchToModel] All local models stopped')
    }

    // 2. Stop the API server so we start it fresh with the new configuration.
    try {
      await window.core?.api?.stopServer()
      console.log('[switchToModel] Server stopped')
    } catch {
      // Server may not have been running — that's fine
    }

    // 3. Resolve the provider definition.
    const allProviders = useModelProvider.getState().providers
    const provider = allProviders.find((p) => p.provider === providerName)
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`)
    }
    modelConfig = provider.models?.find((m) => m.id === modelId) as
      | LoadableModel
      | undefined

    if (isLocal) {
      // 4a. Local branch — load the model into its engine. An out-of-memory
      //     failure is retried down a ladder (smaller context, then CPU)
      //     rather than surfaced as a dead end; see `planOomRetry`.
      loadStartTs = Date.now()
      modelConfig = await loadLocalModelWithOomRetry({
        serviceHub,
        providerName,
        modelId,
      })
      // Awaited rather than fired-and-forgotten: the event has to carry it,
      // and the read is a single IPC against an already-running process.
      const runtimeDevice = await readRuntimeDevice(modelId)
      // Cached so chat responses can name the executing backend without an
      // IPC on the response path.
      rememberExecBackend(modelId, execBackend(runtimeDevice))
      emitModelLoad('success', {
        modelId,
        providerName,
        durationMs: Date.now() - loadStartTs,
        model: modelConfig,
        isAutoStart,
        runtimeDevice,
      })
      console.log('[switchToModel] Local model started:', modelId)
      await settleAfterLocalStart(serviceHub, providerName, modelId)
    } else {
      // 4b. Cloud branch — register the provider so the proxy can route
      //     requests for `modelId` to provider.base_url.
      //     Subscriptions (ChatGPT/Codex) carry no `api_key` by design — the
      //     bearer token lives in the Rust backend and the proxy attaches it
      //     itself — so they must pass this gate exactly like keyless
      //     self-hosted servers do. Mirrors `registerRemoteProvider` and
      //     `ensureRemoteProviderReady`.
      if (
        !provider.api_key &&
        !isKeylessRemoteProvider(provider) &&
        !isSubscriptionProvider(providerName)
      ) {
        throw new Error(
          `Provider '${providerName}' has no API key. Add one in Settings before selecting this model.`
        )
      }
      await registerRemoteProvider(provider)
      console.log('[switchToModel] Cloud provider registered:', providerName)
    }

    // 5. Start the Local API Server. It's a process-wide singleton (one
    //    proxy on serverState.serverPort shared by every provider), so a
    //    "Server is already running" rejection here just means some other
    //    switch/startup path already stood it up — not a load failure. This
    //    matters most on crash recovery (ATO-244): the model above may have
    //    just loaded successfully while a concurrent start-server call (e.g.
    //    from another in-flight switch) wins the race, and without this
    //    guard that benign race would surface as a spurious "Failed to load
    //    the model" toast on top of a model that is, in fact, running fine.
    //    Mirrors the same handling in hermes-agent.tsx / claude-code.tsx.
    //
    //    Gating: the :1337 proxy is a user-facing surface, not a hard
    //    requirement for chatting with a *local* engine (llamacpp/mlx connect
    //    to their own port directly). So when the "Auto-start" toggle is off we
    //    leave it down for a local model — unless it was already running
    //    (manually started), in which case we bring it back up after step 2's
    //    stop. Cloud/remote models always need the proxy to route requests, so
    //    they start it regardless of the toggle (see `shouldStartServer`
    //    computed up front).
    if (shouldStartServer) {
      await startLocalApiServer()
    } else {
      // Local model + auto-start disabled + server wasn't running: keep the
      // Local API Server down. The local engine already serves this chat on
      // its own port; the :1337 proxy stays off until the user enables it.
      setServerStatus('stopped')
      console.log(
        '[switchToModel] Local API Server left stopped (auto-start disabled)'
      )
    }

    // 6. Publish active model(s). For local engines we query the engine; for
    //    cloud we mark the target model as the single active one so the UI
    //    reflects it (engine query would return empty).
    if (isLocal) {
      const active = await serviceHub.models().getActiveModels()
      setActiveModels(active || [])
    } else {
      setActiveModels([modelId])
    }

    // 7. Synchronise the rest of global state (dropdown, thread, localStorage).
    syncModelSelection(providerName, modelId)

    // WS2: load succeeded — clear any prior auto-start failure record so the
    // model is eligible for automatic start again.
    clearAutoStartFailure(providerName, modelId)
    // ATO-63: a previous backend may have raised a persistent "Failed to load"
    // toast; this load succeeded, so dismiss it and clear the stored error.
    clearModelLoadError()
    console.log('[switchToModel] Global state synchronised')
  } catch (error) {
    console.error('[switchToModel] Failed to switch model:', error)
    if (wasServerRunning) {
      try {
        await startLocalApiServer()
        console.log(
          '[switchToModel] Restored Local API Server after switch failure'
        )
      } catch (restoreError) {
        console.error(
          '[switchToModel] Failed to restore Local API Server:',
          restoreError
        )
        useAppState.getState().setServerStatus('stopped')
      }
    } else {
      useAppState.getState().setServerStatus('stopped')
    }
    // WS2: record the failure so the auto-start effect doesn't re-loop on it —
    // terminal codes (missing model/binary) are never auto-retried; others back
    // off. Explicit user switches bypass `shouldAttemptAutoStart`, so a manual
    // retry is always possible.
    recordAutoStartFailure(providerName, modelId, toErrorObject(error).code ?? null)
    if (isLocal) {
      emitModelLoad('failed', {
        modelId,
        providerName,
        durationMs: loadStartTs ? Date.now() - loadStartTs : 0,
        model: modelConfig,
        error,
        isAutoStart,
      })
    }
    // ATO-113 / WS1.5: explicit Sentry capture at the model-load choke point with
    // the typed error_code + zero-PII tags (stderr tail is scrubbed by beforeSend).
    // Recoverable user/config conditions (missing file, unsupported projector) are
    // NOT crashes and are skipped, and repeats are throttled (model+code, 5-min
    // window) so a load crashloop cannot flood the crash channel.
    {
      const err = toErrorObject(error)
      const haystack = err.details ?? err.message
      const settings = modelConfig?.settings
      const errorCode = err.code ?? null
      if (
        !isRecoverableModelLoadCode(errorCode) &&
        shouldCaptureModelLoadSentry(modelId, errorCode)
      ) {
        captureHandledError(
          error,
          isOutOfMemoryError(err) ? 'fatal' : 'error',
          {
            feature: 'model_load',
            error_code: err.code ?? 'unknown',
            oom_subtype: oomSubtype(haystack),
            backend: isLocal
              ? loadBackendFromProvider(providerName)
              : providerName,
            model_id: normalizeModelId(modelId),
            quant: quantFromModelId(modelId),
            context_length:
              settingNum(settings, 'ctx_len') ??
              settingNum(settings, 'ctx_size'),
          },
          { stderr_tail: sanitizeStderrTail(haystack) }
        )
      }
    }
    reportModelLoadError(error, providerName, isAutoStart, modelId)
    throw error
  } finally {
    useAppState.getState().updateLoadingModel(false)
  }
}

/**
 * Out-of-memory retry ladder (ATO-465).
 *
 * A load that ran out of memory used to be the end of the road: a toast
 * saying "pick a smaller model or reduce the context", and nothing tried
 * either. With fit off the ladder halves the context down to
 * {@link OOM_RETRY_CTX_FLOOR}, then sends the model to the CPU; each rung is
 * persisted on the model so the next launch starts from what worked. With
 * fit on the engine already sized the context, so the one thing worth
 * trying is a wider fit margin. Partial GPU offload is not a rung: the
 * layer count is only known to the engine, and fit covers that case.
 */
const OOM_RETRY_MAX_ATTEMPTS = 4
const OOM_RETRY_CTX_FLOOR = 4096
const OOM_RETRY_DEFAULT_FIT_TARGET_MIB = 1024

export type OomRetryStep =
  | { kind: 'ctx'; from: number; to: number }
  | { kind: 'ngl'; from: number; to: number }
  | { kind: 'fit_target'; from: number; to: number }

function modelSettingNumber(
  model: { settings?: Record<string, { controller_props?: { value?: unknown } }> } | undefined,
  key: string
): number | undefined {
  const raw = model?.settings?.[key]?.controller_props?.value
  const n = typeof raw === 'string' ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function providerFitTargetMib(provider: ModelProvider): number {
  const raw = provider.settings?.find((s) => s.key === 'fit_target')
    ?.controller_props?.value
  const first = String(raw ?? '')
    .split(',')[0]
    .trim()
  const n = Number(first)
  return Number.isFinite(n) && n > 0 ? n : OOM_RETRY_DEFAULT_FIT_TARGET_MIB
}

/**
 * The next thing to try after an OOM, or `null` when the ladder is spent.
 * Pure: reads the provider as it is now, so a rung already taken is not
 * taken twice.
 */
export function planOomRetry(
  provider: ModelProvider,
  modelId: string,
  attempt: number
): OomRetryStep | null {
  const model = provider.models?.find((m) => m.id === modelId)
  if (readProviderFit(provider) === true) {
    // The engine chose the context; ask it to leave more room, once.
    if (attempt > 0) return null
    const from = providerFitTargetMib(provider)
    return { kind: 'fit_target', from, to: from * 2 }
  }
  const ctx = modelSettingNumber(model, 'ctx_len') ?? DEFAULT_CTX_LEN
  if (ctx > OOM_RETRY_CTX_FLOOR) {
    return {
      kind: 'ctx',
      from: ctx,
      to: Math.max(OOM_RETRY_CTX_FLOOR, Math.floor(ctx / 2)),
    }
  }
  const ngl = modelSettingNumber(model, 'ngl') ?? 100
  if (ngl !== 0) return { kind: 'ngl', from: ngl, to: 0 }
  return null
}

function applyOomRetryStep(
  serviceHub: ServiceHub,
  provider: ModelProvider,
  modelId: string,
  step: OomRetryStep
): void {
  const { updateProvider } = useModelProvider.getState()
  if (step.kind === 'fit_target') {
    const settings = (provider.settings ?? []).map((s) =>
      s.key === 'fit_target'
        ? {
            ...s,
            controller_props: { ...s.controller_props, value: String(step.to) },
          }
        : s
    )
    void serviceHub.providers().updateSettings(provider.provider, settings)
    updateProvider(provider.provider, { settings })
    return
  }
  const key = step.kind === 'ctx' ? 'ctx_len' : 'ngl'
  const models = (provider.models ?? []).map((m) =>
    m.id === modelId
      ? {
          ...m,
          settings: {
            ...m.settings,
            [key]: {
              ...(m.settings?.[key] ?? { key }),
              controller_props: {
                ...(m.settings?.[key]?.controller_props ?? {}),
                value: step.to,
              },
            },
          },
        }
      : m
  )
  updateProvider(provider.provider, { models: models as Model[] })
}

function emitModelLoadRetry(args: {
  modelId: string
  providerName: string
  attempt: number
  step: OomRetryStep
  outcome: 'retrying' | 'recovered' | 'exhausted'
  fitEnabled: boolean | null
}): void {
  try {
    queuedCapture('model_load_retry', {
      model_id: normalizeModelId(args.modelId),
      backend: loadBackendFromProvider(args.providerName),
      retry_attempt: args.attempt,
      retry_reason: 'oom',
      retry_step: args.step.kind,
      retry_outcome: args.outcome,
      fit_enabled: args.fitEnabled,
      ctx_before: args.step.kind === 'ctx' ? args.step.from : null,
      ctx_after: args.step.kind === 'ctx' ? args.step.to : null,
      ngl_before: args.step.kind === 'ngl' ? args.step.from : null,
      ngl_after: args.step.kind === 'ngl' ? args.step.to : null,
      fit_target_before: args.step.kind === 'fit_target' ? args.step.from : null,
      fit_target_after: args.step.kind === 'fit_target' ? args.step.to : null,
    })
  } catch (telemetryError) {
    console.debug('model_load_retry telemetry failed:', telemetryError)
  }
}

/**
 * Load a local model, walking the OOM ladder on each out-of-memory failure.
 * Resolves to the model as it was finally loaded (its settings may have
 * changed); rethrows the last error when the ladder is spent or the failure
 * is not memory.
 */
async function loadLocalModelWithOomRetry(args: {
  serviceHub: ServiceHub
  providerName: string
  modelId: string
}): Promise<LoadableModel | undefined> {
  const { serviceHub, providerName, modelId } = args
  let lastStep: OomRetryStep | null = null
  for (let attempt = 0; attempt < OOM_RETRY_MAX_ATTEMPTS; attempt++) {
    const provider = useModelProvider
      .getState()
      .providers.find((p) => p.provider === providerName)
    if (!provider) throw new Error(`Provider '${providerName}' not found`)
    const fitEnabled = readProviderFit(provider)
    try {
      await taggedWithTimeout(
        serviceHub.models().startModel(provider, modelId, true),
        MODEL_LOAD_WATCHDOG_MS,
        `Timed out waiting for model "${modelId}" to finish loading.`
      )
      if (lastStep) {
        emitModelLoadRetry({
          modelId,
          providerName,
          attempt,
          step: lastStep,
          outcome: 'recovered',
          fitEnabled,
        })
        toast.info(i18n.t('model-errors:oomRetryRecoveredTitle'), {
          id: `oom-retry-${providerName}-${modelId}`,
          description:
            lastStep.kind === 'ctx'
              ? i18n.t('model-errors:oomRetryRecoveredContext', {
                  context: lastStep.to,
                })
              : lastStep.kind === 'ngl'
                ? i18n.t('model-errors:oomRetryRecoveredCpu')
                : i18n.t('model-errors:oomRetryRecoveredFit'),
        })
      }
      return provider.models?.find((m) => m.id === modelId) as
        | LoadableModel
        | undefined
    } catch (error) {
      if (!isOutOfMemoryError(toErrorObject(error))) throw error
      const step =
        attempt < OOM_RETRY_MAX_ATTEMPTS - 1
          ? planOomRetry(provider, modelId, attempt)
          : null
      if (!step) {
        if (lastStep) {
          emitModelLoadRetry({
            modelId,
            providerName,
            attempt,
            step: lastStep,
            outcome: 'exhausted',
            fitEnabled,
          })
        }
        throw error
      }
      console.warn(
        `[switchToModel] ${modelId} ran out of memory; retrying with ${step.kind} ${step.from} → ${step.to}`
      )
      applyOomRetryStep(serviceHub, provider, modelId, step)
      emitModelLoadRetry({
        modelId,
        providerName,
        attempt: attempt + 1,
        step,
        outcome: 'retrying',
        fitEnabled,
      })
      lastStep = step
    }
  }
  return undefined
}

const OOM_CODES = new Set([
  'OUT_OF_MEMORY',
  'OutOfMemory',
  'OOM',
])

const OOM_MESSAGE_PATTERNS = [
  'out of memory',
  'insufficient memory',
  'failed to allocate',
  'erroroutofdevicememory',
  'kiogpucommandbuffercallbackerroroutofmemory',
  'cuda_error_out_of_memory',
  'requires more ram',
]

function toErrorObject(error: unknown): ErrorObject {
  if (error && typeof error === 'object') {
    const candidate = error as Partial<ErrorObject> & { toString?: () => string }
    const message =
      typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : candidate.toString?.() ?? 'Unknown error'
    return {
      code: typeof candidate.code === 'string' ? candidate.code : undefined,
      message,
      details:
        typeof candidate.details === 'string' ? candidate.details : undefined,
    }
  }
  return { message: String(error ?? 'Unknown error') }
}

/** Longest reason we keep inline before it counts as a log, not a sentence. */
const MAX_SUMMARY_LENGTH = 200
/** The tail holds the crash; anything earlier is startup noise. */
const MAX_DETAILS_LENGTH = 20_000

/** `formatLoadError` appends the engine error code as a ` [CODE]` suffix. */
function stripErrorCodeSuffix(message: string): string {
  return message.replace(/\s*\[[A-Z0-9_]+\]\s*$/, '')
}

function clampDetails(details: string): string {
  if (details.length <= MAX_DETAILS_LENGTH) return details
  return `…\n${details.slice(details.length - MAX_DETAILS_LENGTH)}`
}

/**
 * The llama.cpp extensions hand us `"<one-line reason>\n<raw engine output>"`
 * (see `formatLoadError`), which the toast used to print verbatim — a screenful
 * of GGML backtrace hiding the sentence that mattered. Split it back apart so
 * the toast can show the reason and hide the log behind a toggle.
 */
export function splitModelLoadError(err: ErrorObject): {
  summary: string
  details?: string
} {
  const raw = stripErrorCodeSuffix((err.message ?? '').trim()).trim()
  const newlineAt = raw.indexOf('\n')
  const head = (newlineAt === -1 ? raw : raw.slice(0, newlineAt)).trim()
  const tail = newlineAt === -1 ? '' : raw.slice(newlineAt + 1).trim()
  const details = err.details?.trim() || tail || undefined

  if (head.length <= MAX_SUMMARY_LENGTH) {
    return { summary: head, details: details && clampDetails(details) }
  }

  // One unbroken wall of text: keep a readable opening and demote the rest.
  const cut = head.lastIndexOf(' ', MAX_SUMMARY_LENGTH)
  return {
    summary: `${head.slice(0, cut > 0 ? cut : MAX_SUMMARY_LENGTH).trim()}…`,
    details: clampDetails(details ? `${head}\n\n${details}` : head),
  }
}

function isOutOfMemoryError(err: ErrorObject): boolean {
  if (err.code && OOM_CODES.has(err.code)) return true
  const haystack = `${err.message ?? ''} ${err.details ?? ''}`.toLowerCase()
  return OOM_MESSAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
}

// The two on-device llama.cpp engines are interchangeable for most models, so
// when one rejects a model we can point the user at the other. `llamacpp` is the
// turboquant fork; `llamacpp-upstream` is stock llama.cpp. The turboquant engine
// only ships on macOS, so it's only a valid suggestion there — and only when
// the user hasn't deactivated it (it ships disabled on fresh installs).
function alternateLocalBackend(providerName?: string): string | undefined {
  if (providerName === 'llamacpp') return getProviderTitle('llamacpp-upstream')
  // MLX is macOS-only and its arch support is welded to the bundled sidecar,
  // so a brand-new architecture lands here well before the backend is bumped
  // (issue #250). The GGUF build of the same model runs on llama.cpp today —
  // say so, instead of leaving "update the app" as the only advice.
  if (providerName === 'mlx') return getProviderTitle('llamacpp-upstream')
  if (providerName === 'llamacpp-upstream') {
    const fork = useModelProvider.getState().getProviderByName('llamacpp')
    return IS_MACOS && fork?.active !== false
      ? getProviderTitle('llamacpp')
      : undefined
  }
  return undefined
}

/**
 * Build the description for an "unsupported by this backend" toast, naming the
 * current backend and (when available) the backend to switch to. Falls back to
 * a no-alternative variant on platforms that ship a single engine.
 */
function unsupportedDescription(
  t: typeof i18n.t,
  baseKey: 'multimodalUnsupported' | 'archNotSupported',
  providerName?: string
): string {
  const backend = providerName ? getProviderTitle(providerName) : undefined
  const alternative = alternateLocalBackend(providerName)
  if (backend && alternative) {
    return t(`model-errors:${baseKey}Description`, { backend, alternative })
  }
  return t(`model-errors:${baseKey}DescriptionNoAlt`, {
    backend: backend ?? t('model-errors:currentBackendFallback'),
  })
}

/**
 * Surface a user-visible banner when a model fails to load.
 * OOM errors get a persistent toast so the user cannot miss them.
 */
function reportModelLoadError(
  rawError: unknown,
  providerName?: string,
  isAutoStart?: boolean,
  modelId?: string
): void {
  const err = toErrorObject(rawError)
  useModelLoad.getState().setModelLoadError(err, modelId)

  const t = i18n.t.bind(i18n)

  // ATO-270: a startup watchdog timeout must surface even on auto-start —
  // the alternative is an infinite "Starting Server" spinner with zero
  // feedback and no way for the user to know anything went wrong, let alone
  // retry. This is the one exception to the "auto-start fails silently"
  // policy below.
  if (err.code === LOCAL_API_SERVER_START_TIMEOUT_CODE) {
    toast.error(t('model-errors:startupTimedOutTitle'), {
      id: 'model-load-error',
      description: t('model-errors:startupTimedOutDescription'),
      duration: 10000,
      closeButton: true,
    })
    return
  }

  // Only user-initiated loads surface a toast for every other failure.
  // Automatic/background loads (startup auto-start, ChatInput auto-start,
  // onboarding launches, post-import auto-switch) pass `isAutoStart` and
  // fail silently — the error is still stored above for any inline UI that
  // wants to read it.
  if (isAutoStart) return

  if (isOutOfMemoryError(err)) {
    toast.error(t('model-errors:outOfMemoryTitle'), {
      id: 'model-load-error',
      description: t('model-errors:outOfMemoryDescription'),
      duration: Infinity,
      closeButton: true,
    })
    return
  }

  // ATO-121: map well-classified engine errors to an actionable message + hint
  // instead of the opaque generic "unexpected error". The codes come from the
  // Rust plugins' `LlamacppError` (from_stderr / from_exit_status).
  if (err.code === 'MULTIMODAL_PROJECTOR_LOAD_FAILED') {
    toast.error(t('model-errors:multimodalUnsupportedTitle'), {
      id: 'model-load-error',
      description: unsupportedDescription(t, 'multimodalUnsupported', providerName),
      duration: 10000,
      closeButton: true,
    })
    return
  }
  if (err.code === 'MODEL_ARCH_NOT_SUPPORTED') {
    // The backend names the architecture it choked on, which is the one thing
    // a bug report needs. Keep it one click away instead of dropping it.
    showModelLoadErrorToast({
      title: t('model-errors:archNotSupportedTitle'),
      description: unsupportedDescription(t, 'archNotSupported', providerName),
      details: splitModelLoadError(err).details,
      duration: 10000,
    })
    return
  }
  if (err.code === 'MODEL_FILE_NOT_FOUND') {
    toast.error(t('model-errors:modelFileMissingTitle'), {
      id: 'model-load-error',
      description: t('model-errors:modelFileMissingDescription'),
      duration: 10000,
      closeButton: true,
    })
    return
  }
  // A shard set missing members is an incomplete download by another name, and
  // the remedy the corrupt-file copy already gives — delete and download again —
  // is exactly right for it.
  if (err.code === 'MODEL_FILE_CORRUPT' || err.code === 'MODEL_SHARDS_INCOMPLETE') {
    toast.error(t('model-errors:modelFileCorruptTitle'), {
      id: 'model-load-error',
      description: t('model-errors:modelFileCorruptDescription'),
      duration: 10000,
      closeButton: true,
    })
    return
  }
  // ATO-190: the bundled macOS engine links a Metal symbol absent on older
  // macOS (e.g. Catalina), so the binary fails to load. Tell the user their
  // OS is too old instead of showing a generic crash.
  if (err.code === 'OS_VERSION_UNSUPPORTED') {
    toast.error(t('model-errors:osVersionUnsupportedTitle'), {
      id: 'model-load-error',
      description: t('model-errors:osVersionUnsupportedDescription'),
      duration: Infinity,
      closeButton: true,
    })
    return
  }
  // ATO-185: the host CPU lacks the AVX instruction set the bundled engine
  // requires; loading would otherwise crash with a silent SIGILL surfaced as
  // the opaque LLAMA_CPP_PROCESS_ERROR. Tell the user plainly that their CPU
  // is unsupported instead.
  if (err.code === 'CPU_NO_AVX') {
    toast.error(t('model-errors:cpuNoAvxTitle'), {
      id: 'model-load-error',
      description: t('model-errors:cpuNoAvxDescription'),
      duration: 10000,
      closeButton: true,
    })
    return
  }

  const { summary, details } = splitModelLoadError(err)
  showModelLoadErrorToast({
    title: t('model-errors:modelLoadFailedTitle'),
    description: t('model-errors:modelLoadFailedDescription', {
      message: summary,
    }).trim(),
    details,
    duration: 10000,
  })
}
