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

// jsdom 26 keeps `localStorage` on the window prototype and no longer copies it
// onto the test global, so bare `localStorage` reads `undefined`. Provide the
// in-memory storage the rest of the suite expects; specs that install their own
// `localStorage` mock replace this wholesale and are unaffected.
const localStorageBacking = new Map<string, string>()
const localStorageShim: Storage = {
  get length() {
    return localStorageBacking.size
  },
  clear() {
    localStorageBacking.clear()
  },
  getItem(key: string) {
    return localStorageBacking.has(key) ? localStorageBacking.get(key)! : null
  },
  key(index: number) {
    return Array.from(localStorageBacking.keys())[index] ?? null
  },
  removeItem(key: string) {
    localStorageBacking.delete(key)
  },
  setItem(key: string, value: string) {
    localStorageBacking.set(key, String(value))
  },
}
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: localStorageShim,
})

// `isPlatformTauri()` now probes for the real IPC bridge instead of trusting a
// build-time define, so the suite has to declare which platform it stands in.
// This is the desktop app's test suite, so present the bridge; the handful of
// specs that want the web branch mock `isPlatformTauri` directly. `clearMocks()`
// only deletes properties inside this object, never the object itself, so one
// assignment here survives every test.
;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ ??= {}

// jsdom supplies `AbortSignal`, but the `fetch` it installs is undici's, and
// undici brand-checks the signal against the AbortSignal class it captured
// before jsdom replaced the global. The two are different class objects, so
// every real `fetch(url, { signal })` in the app dies on
// "Expected signal to be an instance of AbortSignal" - which is not a bug in
// the code under test and is unrecoverable from in here: deleting the jsdom
// globals leaves `undefined` rather than uncovering Node's originals.
//
// So translate instead of brand-check: run the fetch without the signal and
// race it against the signal's own abort event. Callers see the AbortError
// they expect at the moment they expect it. The one honest difference is that
// the underlying request is no longer cancelled at the socket, which costs a
// test suite nothing.
//
// Only the real fetch is wrapped. A spec that installs its own `fetch` mock
// replaces this wholesale and is unaffected.
const nativeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (!init?.signal) return nativeFetch(input, init)

  const signal = init.signal
  const rest: RequestInit = { ...init }
  delete rest.signal

  const aborted = () =>
    Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    })

  if (signal.aborted) return Promise.reject(aborted())

  return Promise.race([
    nativeFetch(input, rest),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(aborted()), { once: true })
    }),
  ])
}) as typeof globalThis.fetch

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
