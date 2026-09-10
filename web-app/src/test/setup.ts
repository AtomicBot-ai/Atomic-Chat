import { webcrypto } from 'node:crypto'
import { expect, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useServiceStore } from '@/hooks/useServiceHub'

// extends Vitest's expect method with methods from react-testing-library
expect.extend(matchers)

Object.defineProperty(window, 'crypto', {
  configurable: true,
  value: webcrypto,
})

// Mock window.matchMedia for useMediaQuery tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// `isPlatformTauri()` now probes for the real IPC bridge instead of trusting a
// build-time define, so the suite has to declare which platform it stands in.
// This is the desktop app's test suite, so present the bridge; the handful of
// specs that want the web branch mock `isPlatformTauri` directly. `clearMocks()`
// only deletes properties inside this object, never the object itself, so one
// assignment here survives every test.
;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ??= {}

// Mock globalThis.core.api for @janhq/core functions // cspell: disable-line
;(globalThis as Record<string, unknown>).core = {
  api: {
    getJanDataFolderPath: vi.fn().mockResolvedValue('/mock/jan/data'),
    openFileExplorer: vi.fn().mockResolvedValue(undefined),
    joinPath: vi.fn((...paths: string[]) => paths.join('/')),
  },
}

// Mock globalThis.fs for @janhq/core fs functions // cspell: disable-line
;(globalThis as Record<string, unknown>).fs = {
  existsSync: vi.fn().mockResolvedValue(false),
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn().mockResolvedValue(undefined),
}

// runs a cleanup after each test case (e.g. clearing jsdom)
afterEach(() => {
  clearMocks()
  useServiceStore.setState({ serviceHub: null })
  cleanup()
})
