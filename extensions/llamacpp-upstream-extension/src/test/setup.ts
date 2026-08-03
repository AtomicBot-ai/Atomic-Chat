import { vi } from 'vitest'

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock the global window object for Tauri
Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: localStorageMock,
    core: {
      api: {
        // getSystemInfo: vi.fn(),
      },
      extensionManager: {
        getByName: vi.fn().mockReturnValue({
          downloadFiles: vi.fn().mockResolvedValue(undefined),
          cancelDownload: vi.fn().mockResolvedValue(undefined),
        }),
      },
    },
  },
})

vi.stubGlobal('IS_WINDOWS', false)
vi.stubGlobal('IS_LINUX', false)

vi.mock('../hardware', () => ({
  getSystemInfo: vi.fn(),
  getSystemUsage: vi.fn(),
}))

// Mock Tauri invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}))

// Mock Tauri path API
vi.mock('@tauri-apps/api/path', () => ({
  basename: vi.fn(),
  dirname: vi.fn(),
  join: vi.fn(),
  resolve: vi.fn(),
}))

// Mock @janhq/core
vi.mock('@janhq/core', () => ({
  getJanDataFolderPath: vi.fn(),
  fs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    fileStat: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
  },
  joinPath: vi.fn(),
  modelInfo: {},
  SessionInfo: {},
  UnloadResult: {},
  chatCompletion: {},
  chatCompletionChunk: {},
  ImportOptions: {},
  chatCompletionRequest: {},
  events: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
  AppEvent: {
    onModelImported: 'onModelImported',
    onBackendDownloadStarted: 'onBackendDownloadStarted',
    onBackendDownloadFinished: 'onBackendDownloadFinished',
    onBetterBackendDetected: 'onBetterBackendDetected',
  },
  DownloadEvent: {
    onFileDownloadUpdate: 'onFileDownloadUpdate',
    onFileDownloadError: 'onFileDownloadError',
    onFileDownloadStopped: 'onFileDownloadStopped',
    onModelValidationStarted: 'onModelValidationStarted',
    onModelValidationFailed: 'onModelValidationFailed',
    onFileDownloadAndVerificationSuccess:
      'onFileDownloadAndVerificationSuccess',
  },
  ModelEvent: {
    OnAutoIncreasedCtxLen: 'OnAutoIncreasedCtxLen',
  },
  AIEngine: vi.fn(),
}))
