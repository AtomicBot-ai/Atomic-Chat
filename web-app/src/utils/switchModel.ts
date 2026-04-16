import { toast } from 'sonner'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { localStorageKey } from '@/constants/localStorage'
import i18n from '@/i18n/setup'
import type { ServiceHub } from '@/services'

const LOCAL_PROVIDERS = ['llamacpp', 'mlx'] as const
type LocalProviderName = (typeof LOCAL_PROVIDERS)[number]

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

let activeSwitchPromise: Promise<void> | null = null

function syncLocalModelSelection(providerName: string, modelId: string) {
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
  if (
    !LOCAL_PROVIDERS.includes(providerName as (typeof LOCAL_PROVIDERS)[number])
  ) {
    return false
  }

  const [serverRunning, providerActive, otherProviderActive] = await Promise.all([
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
}): Promise<void> {
  // Wait for any in-flight switch to complete before starting a new one.
  while (activeSwitchPromise) {
    try {
      await activeSwitchPromise
    } catch {
      // Previous switch failed — proceed with the new one.
    }
  }

  if (await isTargetModelAlreadyServing(params)) {
    const activeModels = await params.serviceHub
      .models()
      .getActiveModels()
      .catch(() => [] as string[])

    useAppState.getState().setServerStatus('running')
    useAppState.getState().setActiveModels(activeModels || [])
    syncLocalModelSelection(params.providerName, params.modelId)
    console.log(
      '[switchToModel] Target already active, skipping restart:',
      params.modelId,
      'provider:',
      params.providerName
    )
    return
  }

  const promise = doSwitchToModel(params)
  activeSwitchPromise = promise
  try {
    await promise
  } finally {
    if (activeSwitchPromise === promise) {
      activeSwitchPromise = null
    }
  }
}

async function doSwitchToModel(params: {
  modelId: string
  providerName: string
  serviceHub: ServiceHub
}): Promise<void> {
  const { modelId, providerName, serviceHub } = params

  if (
    !LOCAL_PROVIDERS.includes(providerName as (typeof LOCAL_PROVIDERS)[number])
  ) {
    console.warn(
      `[switchToModel] Provider '${providerName}' is not a local provider, skipping`
    )
    return
  }

  const { setServerStatus, setActiveModels, updateLoadingModel } =
    useAppState.getState()
  const serverState = useLocalApiServer.getState()

  setServerStatus('pending')
  updateLoadingModel(true)
  console.log(
    '[switchToModel] Switching to model:',
    modelId,
    'provider:',
    providerName
  )

  try {
    // 1. Stop ALL local models (both llamacpp and mlx)
    await serviceHub.models().stopAllModels()
    setActiveModels([])
    console.log('[switchToModel] All local models stopped')

    // 2. Stop the API server (safe to call even if it wasn't running)
    try {
      await window.core?.api?.stopServer()
      console.log('[switchToModel] Server stopped')
    } catch {
      // Server may not have been running — that's fine
    }

    // 3. Resolve provider object so we can start the model
    const allProviders = useModelProvider.getState().providers
    const provider = allProviders.find((p) => p.provider === providerName)
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`)
    }

    // 4. Start the new model
    await serviceHub.models().startModel(provider, modelId, true)
    console.log('[switchToModel] Model started:', modelId)
    await new Promise((resolve) => setTimeout(resolve, 500))

    // 5. Start the Local API Server
    const actualPort = await window.core?.api?.startServer({
      host: serverState.serverHost,
      port: serverState.serverPort,
      prefix: serverState.apiPrefix,
      apiKey: serverState.apiKey,
      trustedHosts: serverState.trustedHosts,
      isCorsEnabled: serverState.corsEnabled,
      isVerboseEnabled: serverState.verboseLogs,
      proxyTimeout: serverState.proxyTimeout,
    })
    console.log('[switchToModel] Server started on port:', actualPort)

    if (actualPort && actualPort !== serverState.serverPort) {
      serverState.setServerPort(actualPort)
    }
    setServerStatus('running')
    serverState.setEnableOnStartup(true)

    // 6. Refresh activeModels from the engine so the UI knows the model is ready
    const active = await serviceHub.models().getActiveModels()
    setActiveModels(active || [])

    // 7. Synchronise all global state
    syncLocalModelSelection(providerName, modelId)

    console.log('[switchToModel] Global state synchronised')
  } catch (error) {
    console.error('[switchToModel] Failed to switch model:', error)
    useAppState.getState().setServerStatus('stopped')
    reportModelLoadError(error)
    throw error
  } finally {
    useAppState.getState().updateLoadingModel(false)
  }
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

function isOutOfMemoryError(err: ErrorObject): boolean {
  if (err.code && OOM_CODES.has(err.code)) return true
  const haystack = `${err.message ?? ''} ${err.details ?? ''}`.toLowerCase()
  return OOM_MESSAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
}

/**
 * Surface a user-visible banner when a model fails to load.
 * OOM errors get a persistent toast so the user cannot miss them.
 */
function reportModelLoadError(rawError: unknown): void {
  const err = toErrorObject(rawError)
  useModelLoad.getState().setModelLoadError(err)

  const t = i18n.t.bind(i18n)

  if (isOutOfMemoryError(err)) {
    toast.error(t('model-errors:outOfMemoryTitle'), {
      id: 'model-load-error',
      description: t('model-errors:outOfMemoryDescription'),
      duration: Infinity,
      closeButton: true,
    })
    return
  }

  toast.error(t('model-errors:modelLoadFailedTitle'), {
    id: 'model-load-error',
    description: t('model-errors:modelLoadFailedDescription', {
      message: err.message,
    }),
    duration: 10000,
    closeButton: true,
  })
}
