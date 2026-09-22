import { webcrypto } from 'node:crypto'
import { expect, afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useServiceStore } from '@/hooks/useServiceHub'

// Node >= 25 defines its own `localStorage`/`sessionStorage` on the global
// (they read as `undefined` unless `--localstorage-file` is set), and Vitest's
// jsdom environment leaves every global Node already owns untouched, so the
// bare identifiers stop resolving to jsdom's Storage. Point them back at the
// jsdom window, which is still reachable as `frames` (Vitest aliases only
// `window`/`self`/`top`/`parent` to the Node global). Hoisted above the
// imports so modules that read storage while they load see the same Storage
// the tests do. Writable + configurable, so tests can still assign or
// redefine the property the way they could with Vitest's own globals.
vi.hoisted(() => {
  const jsdomWindow = (globalThis as { frames?: Window }).frames
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    const storage = jsdomWindow?.[key]
    if (!storage) continue
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: storage,
    })
  }
})

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

class MockResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= MockResizeObserver

Element.prototype.scrollIntoView ??= vi.fn()

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
