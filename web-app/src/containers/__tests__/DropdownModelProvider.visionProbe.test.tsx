import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: vi.fn(() => ({ updateCurrentThreadModel: vi.fn() })),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: vi.fn(() => ({ t: (key: string) => key })),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: vi.fn(),
}))

// Drive the popover's open state from the test: the real Popover needs a
// pointer stack jsdom does not provide.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children, onOpenChange }: any) => (
    <div>
      <button
        type="button"
        data-testid="popover-open"
        onClick={() => onOpenChange(true)}
      />
      <button
        type="button"
        data-testid="popover-close"
        onClick={() => onOpenChange(false)}
      />
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: any) => <div>{children}</div>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}))

vi.mock('../ProvidersAvatar', () => ({
  default: () => <div />,
}))

vi.mock('../Capabilities', () => ({
  default: ({ capabilities }: { capabilities: string[] }) => (
    <div data-testid="capabilities">{capabilities.join(',')}</div>
  ),
}))

vi.mock('../ModelSupportStatus', () => ({
  ModelSupportStatus: () => <div />,
}))

vi.mock('../SamplerPopover', () => ({
  SamplerPopover: () => <div />,
}))

type TestModel = { id: string; capabilities: string[] }

let checkMmprojExists: ReturnType<typeof vi.fn>
let updateProvider: ReturnType<typeof vi.fn>

// Probe results are cached per model id for the lifetime of the module, which is
// exactly what is under test here — so each case uses its own model ids.
const mockLlamacppModels = (models: TestModel[]) => {
  const providers = [
    { provider: 'llamacpp', active: true, models, settings: [] },
  ]
  const state = {
    providers,
    selectedProvider: 'llamacpp',
    selectedModel: models[0],
    getProviderByName: (name: string) =>
      providers.find((p) => p.provider === name),
    selectModelProvider: vi.fn(),
    getModelBy: vi.fn(),
    updateProvider,
  }
  vi.mocked(useModelProvider).mockImplementation(((selector?: any) =>
    selector ? selector(state) : state) as never)
}

const openDropdown = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('popover-open'))
  })
}

const closeDropdown = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('popover-close'))
  })
}

describe('DropdownModelProvider vision detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkMmprojExists = vi.fn().mockResolvedValue(true)
    updateProvider = vi.fn()

    seedServiceHub({
      models: {
        checkMmprojExists,
        checkMmprojExistsAndUpdateOffloadMMprojSetting: vi
          .fn()
          .mockResolvedValue(undefined),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
    })

    vi.mocked(useFavoriteModel).mockReturnValue({
      favoriteModels: [],
      addFavorite: vi.fn(),
      removeFavorite: vi.fn(),
      isFavorite: vi.fn(),
      toggleFavorite: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('probes each unknown model once and never re-probes on reopen', async () => {
    mockLlamacppModels([
      { id: 'reopen-a.gguf', capabilities: ['completion'] },
      { id: 'reopen-b.gguf', capabilities: ['completion'] },
      { id: 'reopen-tagged.gguf', capabilities: ['completion', 'vision'] },
    ])
    render(<DropdownModelProvider />)

    await openDropdown()

    // A model that already carries the capability is skipped outright.
    expect(checkMmprojExists.mock.calls.flat()).toEqual([
      'reopen-a.gguf',
      'reopen-b.gguf',
    ])

    await closeDropdown()
    await openDropdown()
    await closeDropdown()
    await openDropdown()

    // The mmproj sidecar cannot appear while the app runs, so reopening the list
    // must not re-run the sweep.
    expect(checkMmprojExists.mock.calls.flat()).toEqual([
      'reopen-a.gguf',
      'reopen-b.gguf',
    ])
  })

  it('writes the detected capabilities back in a single store update', async () => {
    mockLlamacppModels([
      { id: 'batch-a.gguf', capabilities: ['completion'] },
      { id: 'batch-b.gguf', capabilities: ['completion'] },
    ])
    render(<DropdownModelProvider />)

    await openDropdown()

    // One write for the whole batch: a per-model write rewrote the entire
    // providers array (and re-rendered the open list) once per detected model.
    expect(updateProvider).toHaveBeenCalledTimes(1)
    const [providerName, patch] = updateProvider.mock.calls[0]
    expect(providerName).toBe('llamacpp')
    expect(
      (patch.models as TestModel[]).map((model) => [
        model.id,
        model.capabilities.includes('vision'),
      ])
    ).toEqual([
      ['batch-a.gguf', true],
      ['batch-b.gguf', true],
    ])
  })

  it('leaves capabilities alone when no model has an mmproj sidecar', async () => {
    checkMmprojExists.mockResolvedValue(false)
    mockLlamacppModels([
      { id: 'plain-a.gguf', capabilities: ['completion'] },
      { id: 'plain-b.gguf', capabilities: ['completion'] },
    ])
    render(<DropdownModelProvider />)

    await openDropdown()

    expect(checkMmprojExists.mock.calls.flat()).toEqual([
      'plain-a.gguf',
      'plain-b.gguf',
    ])
    expect(updateProvider.mock.calls).toEqual([])
  })
})
