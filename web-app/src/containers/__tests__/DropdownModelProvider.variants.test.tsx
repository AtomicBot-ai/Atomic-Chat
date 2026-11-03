import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

const favorites = vi.hoisted(() => ({ ids: [] as string[] }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: () => ({
    favoriteModels: favorites.ids.map((id) => ({ id })),
  }),
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}))
vi.mock('../ProvidersAvatar', () => ({
  default: ({ provider }: { provider: ModelProvider }) => (
    <span data-testid={`provider-avatar-${provider.provider}`} />
  ),
}))
vi.mock('../ModelSupportStatus', () => ({ ModelSupportStatus: () => null }))
vi.mock('@/utils/switchModel', () => ({
  switchToModel: vi.fn(async () => undefined),
}))

const ids = {
  ollama: 'ollama/gemma-4-12b-uncensored-heretic-abliterated-q4_K_M',
  latest: 'ollama/heretic-12b-latest',
  iq4: 'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS',
  q4: 'unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-Q4_K_M',
  gemma: 'gemma-4-E4B-it-IQ4_XS',
  plain: 'model3.gguf',
}

const model = (id: string, source?: Model['source']) =>
  ({ id, source, capabilities: ['completion'] }) as Model

const providers = [
  {
    provider: 'llamacpp-upstream',
    active: true,
    models: [
      model(ids.ollama, 'ollama'),
      model(ids.latest, 'ollama'),
      model(ids.iq4),
      model(ids.q4),
      model(ids.gemma),
      model(ids.plain),
    ],
    settings: [],
  },
] as unknown as ModelProvider[]

const list = () => screen.getByTestId('popover-content')
const row = (id: string) =>
  within(list()).getByRole('radio', {
    name: new RegExp(`\\(${escapeRegExp(id)}\\)$`),
  })
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const visibleRows = () =>
  within(list())
    .queryAllByRole('radio')
    .map((option) => option.getAttribute('title'))

function renderPicker() {
  render(<DropdownModelProvider />)
  const changeModel = screen.queryByRole('button', {
    name: 'common:changeModel',
  })
  if (changeModel) fireEvent.click(changeModel)
}

beforeEach(() => {
  favorites.ids = []
  useModelLoad.setState({ modelSelectionDeferred: true })
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    pausedDownloads: new Set(),
  })
  useModelProvider.setState({
    providers,
    selectedProvider: 'llamacpp-upstream',
    selectedModel: providers[0].models[2],
  })
  seedServiceHub({
    models: {
      getActiveModels: vi.fn(async () => []),
      checkMmprojExists: vi.fn(async () => false),
      checkMmprojExistsAndUpdateOffloadMMprojSetting: vi.fn(async () => {}),
    } as unknown as ModelsService,
  })
})
afterEach(cleanup)

describe('model picker rows (QA 09, 2.2.23)', () => {
  it('names a model once and puts its quant and owner on a line of their own', () => {
    renderPicker()

    for (const [id, quant] of [
      [ids.iq4, 'IQ4_XS'],
      [ids.q4, 'Q4_K_M'],
    ]) {
      const option = row(id)
      expect(option).toHaveAccessibleName(
        `Qwen3.5 9B, ${quant}, unsloth (${id})`
      )
      expect(option).toHaveAttribute('title', id)
      expect(within(option).getByTestId('model-option-name')).toHaveTextContent(
        /^Qwen3\.5 9B$/
      )
      expect(
        within(option).getByTestId('model-option-details')
      ).toHaveTextContent(new RegExp(`^${quant} · unsloth$`))
    }
    expect(row(ids.iq4)).toHaveAttribute('aria-checked', 'true')
    expect(row(ids.q4)).toHaveAttribute('aria-checked', 'false')
  })

  it('moves the source badge under the name and drops an owner the badge already names', () => {
    renderPicker()

    const option = row(ids.ollama)
    expect(option).toHaveAccessibleName(
      `Gemma 4 12B Uncensored Heretic Abliterated, q4_K_M, Ollama (${ids.ollama})`
    )
    const name = within(option).getByTestId('model-option-name')
    expect(name).toHaveTextContent(
      /^Gemma 4 12B Uncensored Heretic Abliterated$/
    )
    const details = within(option).getByTestId('model-option-details')
    expect(within(details).getByText('Ollama')).toBeInTheDocument()
    expect(details).toHaveTextContent(/^q4_K_MOllama$/)
    expect(within(name).queryByText('Ollama')).toBeNull()

    const latest = row(ids.latest)
    expect(within(latest).getByTestId('model-option-name')).toHaveTextContent(
      /^Heretic 12B Latest$/
    )
    expect(
      within(latest).getByTestId('model-option-details')
    ).toHaveTextContent(/^Ollama$/)
  })

  it('keeps one line for a model with nothing to tell it apart', () => {
    renderPicker()

    const option = row(ids.plain)
    expect(option).toHaveAccessibleName(`Model3 (${ids.plain})`)
    expect(within(option).queryByTestId('model-option-details')).toBeNull()
  })

  it('finds a variant by its quant and by its full id', () => {
    renderPicker()
    const search = screen.getByPlaceholderText('common:searchModels')

    fireEvent.change(search, { target: { value: 'IQ4_XS' } })
    expect(visibleRows()).toEqual(expect.arrayContaining([ids.iq4, ids.gemma]))
    expect(visibleRows()).not.toContain(ids.q4)

    fireEvent.change(search, { target: { value: ids.q4 } })
    expect(visibleRows()).toEqual([ids.q4])
  })

  it('shows favorites the same way, with the engine beside them', () => {
    favorites.ids = [ids.q4]
    renderPicker()

    const option = row(ids.q4)
    expect(
      within(option).getByTestId('provider-avatar-llamacpp-upstream')
    ).toBeInTheDocument()
    expect(
      within(option).getByTestId('model-option-details')
    ).toHaveTextContent(/^Q4_K_M · unsloth$/)
    // A favorite is listed once, not again under its engine.
    expect(within(list()).getAllByTitle(ids.q4)).toHaveLength(1)
  })
})
