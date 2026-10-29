import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'
import { localStorageKey } from '@/constants/localStorage'
import {
  restoreThreadWindowModel,
  threadWindowUrl,
} from '@/lib/thread-window-model'
import { seedServiceHub } from '@/test/service-hub'
import type { ModelsService } from '@/services/models/types'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/i18n/setup', () => ({ default: { t: (key: string) => key } }))
vi.mock('../ModelSupportStatus', () => ({ ModelSupportStatus: () => null }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

const QWEN = 'Qwen2.5-0.5B-Instruct-Q4_K_M'
const qwen = { id: QWEN, capabilities: ['completion'] } as Model

/** What each engine reports loaded; the merged list is their union. */
let loaded: Record<string, string[]>
let getActiveModels: ReturnType<typeof vi.fn>

const provider = (name: string) =>
  ({
    provider: name,
    active: true,
    api_key: '',
    models: [qwen],
    settings: [],
  }) as ModelProvider

const lastUsed = () =>
  JSON.parse(localStorage.getItem(localStorageKey.lastUsedModel) ?? 'null')

/**
 * A new window as main.tsx leaves it with preload off: the local selection
 * cleared, then whatever the window's URL carries restored.
 */
function startThreadWindow(url: string) {
  useModelProvider.setState({ selectedProvider: '', selectedModel: null })
  const { pathname, search } = new URL(url, 'http://localhost')
  restoreThreadWindowModel({ pathname, search })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  loaded = {}
  getActiveModels = vi.fn(async (name?: string) =>
    name ? (loaded[name] ?? []) : [...new Set(Object.values(loaded).flat())]
  )
  seedServiceHub({
    models: {
      getActiveModels,
      checkMmprojExists: vi.fn(async () => false),
      checkMmprojExistsAndUpdateOffloadMMprojSetting: vi.fn(async () => {}),
    } as unknown as ModelsService,
  })
  // TurboQuant registers first, and both llama.cpp providers list the same
  // models folder, so the same id sits under both.
  useModelProvider.setState({
    providers: [provider('llamacpp'), provider('llamacpp-upstream')],
    selectedModel: null,
    selectedProvider: '',
    deletedModels: [],
  })
  useGeneralSetting.setState({ preloadModelOnStartup: false })
  useAppState.setState({ activeModels: [], userStoppedModels: [] })
  useModelLoad.setState({ modelSelectionDeferred: false })
  useModelLoad.getState().setModelLoadError(undefined)
  useLeftPanel.setState({ open: false })
  useRunSettingsPanel.setState({ isOpen: false })
})
afterEach(cleanup)

/**
 * QA 2.2.29 B12: a chat on Qwen2.5 0.5B under llama.cpp upstream, opened in a
 * new window. The first open selected TurboQuant for the same model and began
 * loading it there; the second selected nothing at all.
 */
describe('a chat opened in a new window keeps the model and its provider', () => {
  it('takes the engine that serves a running model, not the first that lists it', async () => {
    loaded = { 'llamacpp-upstream': [QWEN] }

    render(<DropdownModelProvider />)

    await waitFor(() =>
      expect(useModelProvider.getState().selectedModel?.id).toBe(QWEN)
    )
    expect(useModelProvider.getState().selectedProvider).toBe(
      'llamacpp-upstream'
    )
    expect(lastUsed()).toEqual({ provider: 'llamacpp-upstream', model: QWEN })
  })

  it('opens on the provider and model of the opening window', async () => {
    loaded = { 'llamacpp-upstream': [QWEN] }
    useModelProvider.getState().selectModelProvider('llamacpp-upstream', QWEN)
    const url = threadWindowUrl('thread-1')

    startThreadWindow(url)
    render(<DropdownModelProvider />)
    await act(async () => {})

    expect(useModelProvider.getState().selectedProvider).toBe(
      'llamacpp-upstream'
    )
    expect(useModelProvider.getState().selectedModel?.id).toBe(QWEN)
  })

  it('keeps that selection when no engine is running the model', async () => {
    // What the cancelled TurboQuant load left behind: nothing loaded anywhere.
    loaded = {}
    useModelProvider.getState().selectModelProvider('llamacpp-upstream', QWEN)
    const url = threadWindowUrl('thread-1')

    startThreadWindow(url)
    render(<DropdownModelProvider />)
    await act(async () => {})

    expect(useModelProvider.getState().selectedProvider).toBe(
      'llamacpp-upstream'
    )
    expect(useModelProvider.getState().selectedModel?.id).toBe(QWEN)
  })
})
