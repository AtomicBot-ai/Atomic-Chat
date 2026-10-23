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
import { EMBEDDING_MODEL_ID } from '@/constants/models'
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

const chat = { id: 'lfm2.5.gguf', capabilities: ['completion'] } as Model
const embedder = { id: EMBEDDING_MODEL_ID, capabilities: [] } as Model
const mlxChat = { id: 'qwen3-4bit', capabilities: ['completion'] } as Model

let active: string[]
let getActiveModels: ReturnType<typeof vi.fn>

const provider = (name: string, models: Model[]) =>
  ({
    provider: name,
    active: true,
    api_key: '',
    models,
    settings: [],
  }) as ModelProvider

const lastUsed = () =>
  JSON.parse(localStorage.getItem(localStorageKey.lastUsedModel) ?? 'null')

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  active = []
  getActiveModels = vi.fn(async () => active)
  seedServiceHub({
    models: {
      getActiveModels,
      checkMmprojExists: vi.fn(async () => false),
      checkMmprojExistsAndUpdateOffloadMMprojSetting: vi.fn(async () => {}),
    } as unknown as ModelsService,
  })
  useModelProvider.setState({
    providers: [provider('llamacpp-upstream', [embedder, chat])],
    selectedModel: null,
    selectedProvider: '',
    deletedModels: [],
  })
  useAppState.setState({ activeModels: [], userStoppedModels: [] })
  useModelLoad.setState({ modelSelectionDeferred: false })
  useModelLoad.getState().setModelLoadError(undefined)
  useLeftPanel.setState({ open: false })
  useRunSettingsPanel.setState({ isOpen: false })
})
afterEach(cleanup)

/**
 * AC-01: uploading the first project document downloads and loads
 * `sentence-transformer-mini` in llama.cpp. On the way back to the project the
 * composer picked it up as "the running model" and the next send failed with
 * "the current context does not support logits computation".
 */
describe('DropdownModelProvider never fills the composer with an embedding model', () => {
  it('leaves the composer empty when only the indexing embedder is running (preload off)', async () => {
    useGeneralSetting.setState({ preloadModelOnStartup: false })
    active = [EMBEDDING_MODEL_ID]

    render(<DropdownModelProvider />)
    await waitFor(() => expect(getActiveModels).toHaveBeenCalled())
    await act(async () => {})

    expect(useModelProvider.getState().selectedModel).toBeNull()
    expect(useModelProvider.getState().selectedProvider).toBe('')
    expect(lastUsed()).toBeNull()
  })

  it('picks the running chat model over the running embedder (preload off)', async () => {
    useGeneralSetting.setState({ preloadModelOnStartup: false })
    active = [EMBEDDING_MODEL_ID, chat.id]

    render(<DropdownModelProvider />)

    await waitFor(() =>
      expect(useModelProvider.getState().selectedModel?.id).toBe(chat.id)
    )
    expect(useModelProvider.getState().selectedProvider).toBe(
      'llamacpp-upstream'
    )
    expect(lastUsed()).toEqual({
      provider: 'llamacpp-upstream',
      model: chat.id,
    })
  })

  it('replaces a last-used embedder with a chat model (preload on)', async () => {
    useGeneralSetting.setState({ preloadModelOnStartup: true })
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({
        provider: 'llamacpp-upstream',
        model: EMBEDDING_MODEL_ID,
      })
    )

    render(<DropdownModelProvider />)

    await waitFor(() =>
      expect(useModelProvider.getState().selectedModel?.id).toBe(chat.id)
    )
    expect(lastUsed()).toEqual({
      provider: 'llamacpp-upstream',
      model: chat.id,
    })
  })

  it('falls back past an engine that holds only the embedder (preload on)', async () => {
    useGeneralSetting.setState({ preloadModelOnStartup: true })
    useModelProvider.setState({
      providers: [
        provider('llamacpp-upstream', [embedder]),
        provider('mlx', [mlxChat]),
      ],
    })

    render(<DropdownModelProvider />)

    await waitFor(() =>
      expect(useModelProvider.getState().selectedModel?.id).toBe(mlxChat.id)
    )
    expect(useModelProvider.getState().selectedProvider).toBe('mlx')
  })
})
