import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'
import { localStorageKey } from '@/constants/localStorage'
import { seedServiceHub } from '@/test/service-hub'
import type { ModelsService } from '@/services/models/types'
import type { ServiceHub } from '@/services'
import { restartLocalModel } from '@/utils/restartLocalModel'
import {
  shouldAttemptAutoStart,
  stopAllLocalModelsByUser,
  switchToModel,
  unloadModelByUser,
} from '@/utils/switchModel'
import common from '@/locales/en/common.json'
import { getProviderTitle } from '@/lib/utils'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: translate }),
}))
vi.mock('@/i18n/setup', () => ({ default: { t: (key: string) => key } }))
vi.mock('../ModelSupportStatus', () => ({ ModelSupportStatus: () => null }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

function translate(key: string) {
  const path = key.replace('common:', '').split('.')
  return (
    (path.reduce<unknown>(
      (value, part) => (value as Record<string, unknown>)?.[part],
      common
    ) as string) || key
  )
}

const localProviders = [
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
  'foundation-models',
]
const model = {
  id: 'qwen3.gguf',
  displayName: 'Qwen 3',
  capabilities: ['completion'],
} as Model
const pill = () =>
  document.querySelector('[data-test-id="model-picker-trigger"]') as HTMLElement
const indicator = () => screen.queryByTestId('active-model-indicator')
let loaded: Map<string, string[]>
let hub: ServiceHub
let models: ModelsService

function select(provider: string) {
  useModelProvider.getState().selectModelProvider(provider, model.id)
  loaded.set(provider, [model.id])
  useAppState.getState().setActiveModels([model.id])
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  loaded = new Map()
  models = {
    getActiveModels: vi.fn(async (provider?: string) =>
      provider
        ? (loaded.get(provider) ?? [])
        : [...new Set([...loaded.values()].flat())]
    ),
    stopModel: vi.fn(async (id: string, provider: string) => {
      loaded.set(
        provider,
        (loaded.get(provider) ?? []).filter((active) => active !== id)
      )
      return { success: true }
    }),
    stopAllModels: vi.fn(async () => {
      loaded.clear()
    }),
    stopAllModelsExcept: vi.fn(async (id: string, provider: string) => {
      for (const [name, ids] of loaded)
        loaded.set(
          name,
          name === provider ? ids.filter((active) => active === id) : []
        )
    }),
    startModel: vi.fn(async (provider: ModelProvider, id: string) => {
      loaded.set(provider.provider, [id])
    }),
    checkMmprojExists: vi.fn(async () => false),
    checkMmprojExistsAndUpdateOffloadMMprojSetting: vi.fn(async () => {}),
  } as unknown as ModelsService
  hub = seedServiceHub({
    models,
    app: { getServerStatus: async () => false } as ReturnType<
      ServiceHub['app']
    >,
  })
  useModelProvider.setState({
    providers: localProviders.map(
      (provider) =>
        ({
          provider,
          active: true,
          api_key: '',
          models: [model],
          settings: [],
        }) as ModelProvider
    ),
    selectedModel: null,
    selectedProvider: '',
    deletedModels: [],
  })
  useAppState.setState({
    activeModels: [],
    userStoppedModels: [],
    loadingModel: false,
    loadingModelId: undefined,
    serverStatus: 'stopped',
  })
  useModelLoad.getState().setModelLoadError(undefined)
  useGeneralSetting.setState({ preloadModelOnStartup: true })
  useLocalApiServer.setState({ enableOnStartup: false })
  useLeftPanel.setState({ open: false })
  useRunSettingsPanel.setState({ isOpen: false })
})
afterEach(cleanup)

describe.each(localProviders)('explicit unload from %s', (provider) => {
  it.each([false, true])(
    'clears the composer and retains a selectable download (preload=%s)',
    async (preloadModelOnStartup) => {
      useGeneralSetting.setState({ preloadModelOnStartup })
      select(provider)
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({ provider, model: model.id })
      )
      const catalog = useModelProvider.getState().providers
      const view = render(<DropdownModelProvider />)
      expect(pill()).toHaveTextContent('Qwen 3')
      expect(indicator()).toHaveAttribute('data-status', 'ready')
      fireEvent.click(indicator()!)
      await waitFor(() => expect(pill()).toHaveTextContent('Select Model'))
      expect(pill()).not.toHaveTextContent('Qwen 3')
      expect(pill()).not.toHaveAttribute('title', model.id)
      expect(indicator()).toBeNull()
      expect(useAppState.getState().activeModels).toEqual([])
      expect(useModelProvider.getState().providers).toBe(catalog)
      expect(useModelProvider.getState().deletedModels).toEqual([])
      expect(shouldAttemptAutoStart(provider, model.id)).toBe(false)
      // Navigating back into the composer must not restore last-used/preload.
      view.unmount()
      render(<DropdownModelProvider />)
      await waitFor(() => expect(pill()).toHaveTextContent('Select Model'))
      fireEvent.click(pill())
      const heading = await screen.findByText(getProviderTitle(provider))
      const group = heading.parentElement!.parentElement!.parentElement!
      fireEvent.click(within(group).getByText('Qwen 3'))
      await waitFor(() =>
        expect(indicator()).toHaveAttribute('data-status', 'ready')
      )
      expect(pill()).toHaveTextContent('Qwen 3')
      expect(loaded.get(provider)).toEqual([model.id])
      expect(useModelProvider.getState().selectedProvider).toBe(provider)
      expect(shouldAttemptAutoStart(provider, model.id)).toBe(true)
    }
  )
  it('also clears the matching selection after Settings Stop', async () => {
    select(provider)
    render(<DropdownModelProvider />)
    await act(() => stopAllLocalModelsByUser(hub))
    expect(pill()).toHaveTextContent('Select Model')
    expect(
      useModelProvider.getState().getProviderByName(provider)?.models
    ).toEqual([model])
  })
  it('keeps the selection through a temporary backend restart', async () => {
    select(provider)
    render(<DropdownModelProvider />)
    await act(() => restartLocalModel(hub, provider, model.id))
    expect(pill()).toHaveTextContent('Qwen 3')
    expect(indicator()).toHaveAttribute('data-status', 'ready')
  })
  it('goes back to Select Model after a failed load, and a pick retries it', async () => {
    select(provider)
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider, model: model.id })
    )
    const view = render(<DropdownModelProvider />)
    act(() => {
      loaded.delete(provider)
      useAppState.getState().setActiveModels([])
    })
    vi.mocked(models.startModel).mockImplementationOnce(async () => {
      loaded.delete(provider)
      throw new Error('unsupported architecture')
    })
    await act(async () => {
      await expect(
        switchToModel({
          providerName: provider,
          modelId: model.id,
          serviceHub: hub,
        })
      ).rejects.toThrow('unsupported architecture')
    })
    expect(pill()).toHaveTextContent('Select Model')
    expect(pill()).not.toHaveTextContent('Qwen 3')
    expect(indicator()).toBeNull()
    // Preload must not put the model that just failed back on remount.
    view.unmount()
    render(<DropdownModelProvider />)
    await act(async () => {})
    expect(pill()).toHaveTextContent('Select Model')
    expect(useModelProvider.getState().selectedProvider).toBe('')
    await act(() =>
      switchToModel({
        providerName: provider,
        modelId: model.id,
        serviceHub: hub,
      })
    )
    expect(pill()).toHaveTextContent('Qwen 3')
    expect(indicator()).toHaveAttribute('data-status', 'ready')
  })
})

it.each(['result', 'throw'] as const)(
  'retains selection if unload fails via %s',
  async (failure) => {
    select('mlx')
    render(<DropdownModelProvider />)
    if (failure === 'result')
      vi.mocked(models.stopModel).mockResolvedValueOnce({
        success: false,
        error: 'busy',
      })
    else vi.mocked(models.stopModel).mockRejectedValueOnce(new Error('busy'))
    await act(async () => {
      await expect(
        unloadModelByUser({
          providerName: 'mlx',
          modelId: model.id,
          serviceHub: hub,
        })
      ).rejects.toThrow('busy')
    })
    expect(pill()).toHaveTextContent('Qwen 3')
    expect(indicator()).toHaveAttribute('data-status', 'ready')
  }
)

it('does not clear a different provider selection with the same model id while unloading', async () => {
  select('mlx')
  let finish!: () => void
  vi.mocked(models.stopModel).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    loaded.delete('mlx')
    return { success: true }
  })
  render(<DropdownModelProvider />)
  fireEvent.click(indicator()!)
  expect(pill()).toHaveTextContent('Qwen 3')
  expect(indicator()).toBeDisabled()
  act(() => select('llamacpp-upstream'))
  await act(async () => {
    finish()
  })
  expect(pill()).toHaveTextContent('Qwen 3')
  expect(useModelProvider.getState().selectedProvider).toBe('llamacpp-upstream')
})

it('retains the selection when Settings Stop silently fails to unload it', async () => {
  select('mlx')
  vi.mocked(models.stopAllModels).mockResolvedValueOnce(undefined)
  render(<DropdownModelProvider />)
  await act(() => stopAllLocalModelsByUser(hub))
  expect(pill()).toHaveTextContent('Qwen 3')
  expect(indicator()).toHaveAttribute('data-status', 'ready')
})
