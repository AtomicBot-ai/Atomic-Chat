/**
 * Ollama, run and configured from Radium. Thin, typed wrappers over the
 * `ollama_*` commands in `src-tauri/src/core/runtimes/ollama/`, plus the
 * settings form described as data so the panel renders it with the same
 * controls as every other Radium setting.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface OllamaSettings {
  port: number
  allowNetwork: boolean
  modelsDir: string
  contextLength: number
  keepAlive: string
  flashAttention: boolean
  kvCacheType: string
  numParallel: number
  maxLoadedModels: number
  gpus: string
  spreadAcrossGpus: boolean
  gpuOverheadMib: number
  noCloud: boolean
  autoStart: boolean
  extraEnv: string
}

export interface OllamaBinary {
  path: string
  source: 'radium' | 'system'
}

export interface ExternalProcess {
  pid: number
  name: string
  exe: string | null
}

export interface OllamaStatus {
  running: boolean
  pid: number | null
  baseUrl: string
  startedAtMs: number | null
  version: string | null
  binary: OllamaBinary | null
  canInstall: boolean
  installVersion: string
  installBytes: number | null
  settings: OllamaSettings
  defaultModelsDir: string | null
  external: {
    baseUrl: string
    version: string | null
    processes: ExternalProcess[]
  } | null
}

export interface InstalledModel {
  name: string
  sizeBytes: number
  modifiedAt: string | null
  family: string | null
  parameterSize: string | null
  quantization: string | null
}

export interface LoadedModel {
  name: string
  sizeBytes: number
  vramBytes: number
  expiresAt: string | null
}

export interface ModelList {
  installed: InstalledModel[]
  loaded: LoadedModel[]
}

export interface PullProgress {
  status: string
  completed: number | null
  total: number | null
  done: boolean
}

export const ollama = {
  status: () => invoke<OllamaStatus>('ollama_status'),
  start: () => invoke<OllamaStatus>('ollama_start'),
  stop: () => invoke<OllamaStatus>('ollama_stop'),
  restart: () => invoke<OllamaStatus>('ollama_restart'),
  takeOver: () => invoke<OllamaStatus>('ollama_take_over'),
  saveSettings: (settings: OllamaSettings) =>
    invoke<{ settings: OllamaSettings; needsRestart: boolean }>(
      'ollama_settings_set',
      { settings }
    ),
  logs: (lines = 300) => invoke<string[]>('ollama_logs', { lines }),
  models: (baseUrl: string) => invoke<ModelList>('ollama_models', { baseUrl }),
  deleteModel: (baseUrl: string, model: string) =>
    invoke<void>('ollama_delete_model', { baseUrl, model }),
  loadModel: (baseUrl: string, model: string) =>
    invoke<void>('ollama_load_model', { baseUrl, model }),
  unloadModel: (baseUrl: string, model: string) =>
    invoke<void>('ollama_unload_model', { baseUrl, model }),

  /** Downloads Radium's pinned copy; `onProgress` gets bytes so far and total. */
  async install(
    taskId: string,
    onProgress: (received: number, total: number) => void
  ): Promise<OllamaBinary> {
    const unlisten = await listen<{ transferred: number; total: number }>(
      `download-${taskId}`,
      (event) => onProgress(event.payload.transferred, event.payload.total)
    )
    try {
      return await invoke<OllamaBinary>('ollama_install', { taskId })
    } finally {
      unlisten()
    }
  },
  cancelInstall: (taskId: string) =>
    invoke<void>('cancel_download_task', { taskId }),

  /** Downloads a model into Ollama, reporting each progress line. */
  async pull(
    baseUrl: string,
    model: string,
    taskId: string,
    onProgress: (progress: PullProgress) => void
  ): Promise<void> {
    const unlisten: UnlistenFn = await listen<PullProgress>(
      `ollama-pull-${taskId}`,
      (event) => onProgress(event.payload)
    )
    try {
      await invoke<void>('ollama_pull', { baseUrl, model, taskId })
    } finally {
      unlisten()
    }
  },
  cancelPull: (taskId: string) =>
    invoke<boolean>('ollama_pull_cancel', { taskId }),
}

// --- the settings form, as data ------------------------------------------------

export type SettingField = {
  key: keyof OllamaSettings
  title: string
  description: string
  controllerType: 'input' | 'checkbox' | 'dropdown' | 'textarea'
  /** Shown only under "Advanced". */
  advanced?: boolean
  inputType?: 'number' | 'text'
  placeholder?: string
  options?: Array<{ value: string; name: string }>
}

/**
 * Every Ollama server setting Radium exposes. Titles and descriptions say what
 * the setting does in plain words; the Ollama variable each maps to is named
 * so nothing is hidden from people who know Ollama.
 */
export function ollamaSettingFields(
  gpus: Array<{ uuid: string; name: string }>
): SettingField[] {
  return [
    {
      key: 'contextLength',
      title: 'Context length',
      description:
        'How many tokens of conversation a model can see. 0 lets Ollama pick from free VRAM. Larger uses more memory. (OLLAMA_CONTEXT_LENGTH)',
      controllerType: 'input',
      inputType: 'number',
      placeholder: '0 = automatic',
    },
    {
      key: 'keepAlive',
      title: 'Keep models loaded for',
      description:
        'How long an idle model stays in memory: 5m, 30m, 1h, 0 to unload at once, -1 to keep forever. (OLLAMA_KEEP_ALIVE)',
      controllerType: 'input',
      inputType: 'text',
      placeholder: '5m',
    },
    {
      key: 'gpus',
      title: 'GPU',
      description:
        'Which graphics card Ollama may use. All GPUs lets Ollama place each model where it fits. (CUDA_VISIBLE_DEVICES)',
      controllerType: 'dropdown',
      options: [
        { value: '', name: 'All GPUs' },
        ...gpus.map((gpu, index) => ({
          value: gpu.uuid,
          name: `GPU ${index}: ${gpu.name}`,
        })),
      ],
    },
    {
      key: 'flashAttention',
      title: 'Flash attention',
      description:
        'Faster and lighter on memory for most modern models. Needed for a compressed K/V cache. (OLLAMA_FLASH_ATTENTION)',
      controllerType: 'checkbox',
    },
    {
      key: 'autoStart',
      title: 'Start with Radium',
      description:
        'Start Ollama automatically when Radium opens, and stop it when Radium quits.',
      controllerType: 'checkbox',
    },
    {
      key: 'modelsDir',
      title: 'Models folder',
      description:
        'Where models are stored. Leave empty to keep using your existing Ollama models, so nothing downloads twice. (OLLAMA_MODELS)',
      controllerType: 'input',
      inputType: 'text',
      advanced: true,
    },
    {
      key: 'kvCacheType',
      title: 'K/V cache type',
      description:
        'Compress the conversation memory: q8_0 halves it with little quality loss, q4_0 quarters it. Needs flash attention. (OLLAMA_KV_CACHE_TYPE)',
      controllerType: 'dropdown',
      advanced: true,
      options: [
        { value: 'f16', name: 'f16 (full)' },
        { value: 'q8_0', name: 'q8_0 (half)' },
        { value: 'q4_0', name: 'q4_0 (quarter)' },
      ],
    },
    {
      key: 'spreadAcrossGpus',
      title: 'Spread models across all GPUs',
      description:
        'Always split a model over every card, even when it fits on one. Usually slower; useful to balance memory. (OLLAMA_SCHED_SPREAD)',
      controllerType: 'checkbox',
      advanced: true,
    },
    {
      key: 'numParallel',
      title: 'Parallel requests',
      description:
        'Requests each model answers at once. 0 keeps Ollama’s default. (OLLAMA_NUM_PARALLEL)',
      controllerType: 'input',
      inputType: 'number',
      advanced: true,
    },
    {
      key: 'maxLoadedModels',
      title: 'Models loaded at once (per GPU)',
      description: '0 keeps Ollama’s default. (OLLAMA_MAX_LOADED_MODELS)',
      controllerType: 'input',
      inputType: 'number',
      advanced: true,
    },
    {
      key: 'gpuOverheadMib',
      title: 'Reserve VRAM per GPU (MiB)',
      description:
        'Leave this much memory free on each card for other programs, such as the media engine. (OLLAMA_GPU_OVERHEAD)',
      controllerType: 'input',
      inputType: 'number',
      advanced: true,
    },
    {
      key: 'port',
      title: 'Port',
      description:
        'Ollama’s address on this computer. 11434 is Ollama’s standard port. (OLLAMA_HOST)',
      controllerType: 'input',
      inputType: 'number',
      advanced: true,
    },
    {
      key: 'allowNetwork',
      title: 'Allow other computers',
      description:
        'Listen on your network instead of only this computer. Ollama has no password: only turn this on for a network you trust. (OLLAMA_HOST=0.0.0.0)',
      controllerType: 'checkbox',
      advanced: true,
    },
    {
      key: 'noCloud',
      title: 'Turn off Ollama cloud features',
      description:
        'Disable cloud models and web search, keeping everything on this computer. (OLLAMA_NO_CLOUD)',
      controllerType: 'checkbox',
      advanced: true,
    },
    {
      key: 'extraEnv',
      title: 'Other environment variables',
      description:
        'Any other Ollama variable, one KEY=VALUE per line. Applied last, so it overrides the settings above.',
      controllerType: 'textarea',
      placeholder: 'OLLAMA_DEBUG=1',
      advanced: true,
    },
  ]
}

/** Turns a control's value back into the setting's type. */
export function coerceSetting(
  field: SettingField,
  value: string | number | boolean
): OllamaSettings[keyof OllamaSettings] {
  if (field.controllerType === 'checkbox') return Boolean(value)
  if (field.inputType === 'number') {
    const parsed =
      typeof value === 'number' ? value : Number.parseInt(String(value), 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  }
  return String(value)
}

/** Keys whose change the running Ollama only picks up after a restart. */
export function changedKeys(
  a: OllamaSettings,
  b: OllamaSettings
): Array<keyof OllamaSettings> {
  return (Object.keys(a) as Array<keyof OllamaSettings>).filter(
    (key) => a[key] !== b[key]
  )
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** "pulling 1a2b…: 42%" style line for a pull update. */
export function describePull(progress: PullProgress): {
  label: string
  percent: number | null
} {
  const percent =
    progress.total && progress.total > 0 && progress.completed !== null
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : null
  const status = progress.status.replace(
    /^pulling ([0-9a-f]{12})[0-9a-f]*$/,
    'downloading $1'
  )
  return { label: status || 'working', percent }
}
