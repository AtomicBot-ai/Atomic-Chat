import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HUB_FILTERS, type HubFilterState } from '@/lib/hub-filters'

const hardware = vi.hoisted(() => ({
  state: {
    hardwareData: {
      cpu: { name: 'Apple M4 Max' },
      os_name: 'macOS 26',
      total_memory: 32 * 1024,
      gpus: [] as Array<{ total_memory?: number }>,
    },
  },
}))

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (selector: (state: typeof hardware.state) => unknown) =>
    selector(hardware.state),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

const tensorrt = vi.hoisted(() => ({ visible: false }))
const vllm = vi.hoisted(() => ({ visible: false }))
const sglang = vi.hoisted(() => ({ visible: false }))
vi.mock('@/hooks/useManagedHubState', () => {
  const hub = (visible: boolean) => ({
    visible,
    state: 'unknown',
    blockers: [],
    descriptorId: null,
  })
  return {
    useManagedHubStates: () => [
      {
        engine: { id: 'vllm', label: 'vLLM', i18n: 'vllm' },
        hub: hub(vllm.visible),
      },
      {
        engine: { id: 'sglang', label: 'SGLang', i18n: 'sglang' },
        hub: hub(sglang.visible),
      },
      {
        engine: { id: 'tensorrt-llm', label: 'TensorRT-LLM', i18n: 'tensorrt' },
        hub: hub(tensorrt.visible),
      },
    ],
  }
})

import { HubFilters } from '../HubFilters'
import { useModelLikes } from '@/hooks/useModelLikes'
import { useModelProvider } from '@/hooks/useModelProvider'

const withProviders = (...ids: string[]) =>
  useModelProvider.setState({
    providers: ids.map(
      (provider) => ({ provider, models: [], settings: [] }) as never
    ),
  })

/**
 * `HubFilters` is controlled, so a click only changes what the user sees once
 * the parent feeds the new state back. Driving it from real state keeps the
 * assertions on rendered output rather than on the shape of a callback.
 */
const renderFilters = (
  overrides: Partial<HubFilterState> = {},
  props: Partial<React.ComponentProps<typeof HubFilters>> = {}
) => {
  const onChange = vi.fn()
  const Harness = () => {
    const [state, setState] = useState<HubFilterState>({
      ...DEFAULT_HUB_FILTERS,
      ...overrides,
    })
    return (
      <HubFilters
        state={state}
        onChange={(next) => {
          onChange(next)
          setState(next)
        }}
        {...props}
      />
    )
  }
  render(<Harness />)
  return { onChange }
}

type User = ReturnType<typeof userEvent.setup>

const openFilters = async (user: User) => {
  await user.click(screen.getByRole('button', { name: 'hub:filters.label' }))
  return screen.findByRole('menu')
}

const openSortMenu = async (user: User) => {
  await user.click(screen.getByRole('button', { name: /hub:sortBy/ }))
  return screen.findByRole('menu')
}

/** The radio group of the open menu that holds `item`. */
const groupWith = (menu: HTMLElement, item: string) =>
  within(menu)
    .getAllByRole('group')
    .find((group) =>
      within(group).queryByRole('menuitemradio', { name: item })
    )!

const radios = (group: HTMLElement) =>
  within(group)
    .getAllByRole('menuitemradio')
    .map((radio) => radio.textContent)

describe('HubFilters', () => {
  beforeEach(() => {
    hardware.state.hardwareData = {
      cpu: { name: 'Apple M4 Max' },
      os_name: 'macOS 26',
      total_memory: 32 * 1024,
      gpus: [],
    }
    tensorrt.visible = false
    vllm.visible = false
    sglang.visible = false
    withProviders('llamacpp-upstream')
    useModelLikes.setState({ liked: [], onlyLiked: false })
  })

  it('offers neither a format nor an engine where only GGUF on llama.cpp exists', async () => {
    // IS_MACOS is false in the vitest define block: no MLX.
    const user = userEvent.setup()
    renderFilters()

    const menu = await openFilters(user)
    expect(
      within(menu).queryByText('hub:filters.format')
    ).not.toBeInTheDocument()
    expect(
      within(menu).queryByText('hub:filters.engine')
    ).not.toBeInTheDocument()
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'hub:uncensored' })
    ).toBeInTheDocument()
  })

  it('offers TensorRT-LLM next to GGUF where its provider is shown, and switches to it', async () => {
    tensorrt.visible = true
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    const menu = await openFilters(user)
    const formats = groupWith(menu, 'GGUF')
    expect(radios(formats)).toEqual(['GGUF', 'TensorRT-LLM'])
    await user.click(
      within(formats).getByRole('menuitemradio', { name: 'TensorRT-LLM' })
    )

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ formats: ['tensorrt-llm'], engine: undefined })
    )
    expect(
      within(groupWith(menu, 'GGUF')).getByRole('menuitemradio', {
        name: 'TensorRT-LLM',
      })
    ).toBeChecked()
  })

  it('keeps vLLM, SGLang and TensorRT-LLM as formats of their own, in that order (spec sglang-desktop "Порядок трёх движков")', async () => {
    tensorrt.visible = true
    vllm.visible = true
    sglang.visible = true
    withProviders('llamacpp-upstream', 'foundry-local')
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    const menu = await openFilters(user)
    expect(radios(groupWith(menu, 'GGUF'))).toEqual([
      'GGUF',
      'vLLM',
      'SGLang',
      'TensorRT-LLM',
      'Foundry Local',
    ])
    await user.click(
      within(groupWith(menu, 'GGUF')).getByRole('menuitemradio', {
        name: 'SGLang',
      })
    )
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ formats: ['sglang'] })
    )
  })

  it('names each engine this machine offers, TurboQuant only where its provider is installed', async () => {
    vllm.visible = true
    withProviders('llamacpp-upstream', 'llamacpp', 'atomic-prism')
    const user = userEvent.setup()
    renderFilters()

    const menu = await openFilters(user)
    expect(radios(groupWith(menu, 'hub:filters.allEngines'))).toEqual([
      'hub:filters.allEngines',
      'llama.cpp',
      'llama.cpp turboquant',
      'PrismML llama.cpp',
      'vLLM',
    ])
  })

  it('narrows to an engine through its format, counts it, and drops it with a format pick', async () => {
    withProviders('llamacpp-upstream', 'llamacpp', 'atomic-prism')
    const user = userEvent.setup()
    const { onChange } = renderFilters({ onlyFitting: false })

    let menu = await openFilters(user)
    await user.click(
      within(menu).getByRole('menuitemradio', { name: 'PrismML llama.cpp' })
    )
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        engine: 'atomic-prism',
        formats: ['atomic-prism'],
      })
    )
    await user.keyboard('{Escape}')
    expect(
      screen.getByRole('button', { name: 'hub:filters.label' })
    ).toHaveTextContent('1')

    menu = await openFilters(user)
    await user.click(
      within(groupWith(menu, 'GGUF')).getByRole('menuitemradio', {
        name: 'GGUF',
      })
    )
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ engine: undefined, formats: ['gguf'] })
    )
  })

  it('shows only liked models from the menu, kept for this launch', async () => {
    const user = userEvent.setup()
    renderFilters()

    const menu = await openFilters(user)
    await user.click(
      within(menu).getByRole('menuitemcheckbox', { name: 'hub:filters.liked' })
    )

    expect(useModelLikes.getState().onlyLiked).toBe(true)
    // The menu stays open: the effect on the list is visible.
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:filters.liked' })
    ).toBeChecked()
    expect(localStorage.getItem('atomic-model-likes') ?? '').not.toContain(
      'onlyLiked'
    )
  })

  it('narrows to uncensored builds from the menu, off by default', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    const menu = await openFilters(user)
    const box = within(menu).getByRole('menuitemcheckbox', {
      name: 'hub:uncensored',
    })
    expect(box).not.toBeChecked()
    expect(box).toHaveAttribute('title', 'hub:uncensoredHint')

    await user.click(box)

    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:uncensored' })
    ).toBeChecked()
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ uncensored: true })
    )
  })

  it('carries the device filter, on by default and counted on the trigger', async () => {
    const user = userEvent.setup()
    renderFilters()

    expect(
      screen.getByRole('button', { name: 'hub:filters.label' })
    ).toHaveTextContent('1')
    const menu = await openFilters(user)
    expect(
      within(menu).getByRole('menuitemcheckbox', {
        name: 'hub:fitFilterLabel',
      })
    ).toBeChecked()
  })

  it('still says what Filters and Sort are when the narrow toolbar shows their icons alone', () => {
    renderFilters()

    // The compact toolbar hides the words in `.hub-toolbar-label`; the count,
    // the accessible names and the tooltips stay.
    const filters = screen.getByRole('button', { name: 'hub:filters.label' })
    const sort = screen.getByRole('button', { name: 'hub:sortBy' })
    expect(filters).toHaveAttribute('title', 'hub:filters.button')
    expect(sort).toHaveAttribute('title', 'hub:sortRecommended')
    for (const [button, label] of [
      [filters, 'hub:filters.button'],
      [sort, 'hub:sort'],
    ] as const) {
      expect(button.querySelector('.hub-toolbar-label')).toHaveTextContent(
        label
      )
    }
    expect(filters).toHaveTextContent('1')
  })

  it('turns the device filter off and keeps the menu open', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    await openFilters(user)
    await user.click(
      screen.getByRole('menuitemcheckbox', { name: 'hub:fitFilterLabel' })
    )

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ onlyFitting: false })
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:fitFilterLabel' })
    ).not.toBeChecked()
  })

  it('carries the installed filter, which turns the device filter off', async () => {
    const user = userEvent.setup()
    const onShowOnlyDownloadedChange = vi.fn()
    const { onChange } = renderFilters(
      {},
      { showOnlyDownloaded: false, onShowOnlyDownloadedChange }
    )

    await openFilters(user)
    const item = screen.getByRole('menuitemcheckbox', {
      name: 'hub:installedOnDevice',
    })
    expect(item).not.toBeChecked()
    expect(item).toHaveClass(
      'data-[state=checked]:[&>span:first-child]:bg-primary'
    )

    await user.click(item)

    expect(onShowOnlyDownloadedChange).toHaveBeenCalledWith(true)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ onlyFitting: false })
    )
  })

  it('turns off the installed filter when device fit is selected', async () => {
    const user = userEvent.setup()
    const onShowOnlyDownloadedChange = vi.fn()
    renderFilters(
      { onlyFitting: false },
      { showOnlyDownloaded: true, onShowOnlyDownloadedChange }
    )

    await openFilters(user)
    const fitItem = screen.getByRole('menuitemcheckbox', {
      name: 'hub:fitFilterLabel',
    })
    await user.click(fitItem)

    expect(fitItem).toBeChecked()
    expect(onShowOnlyDownloadedChange).toHaveBeenCalledWith(false)
  })

  it('hides the device filter until hardware detection resolves', async () => {
    hardware.state.hardwareData = {
      cpu: { name: '' },
      os_name: '',
      total_memory: 0,
      gpus: [],
    }
    const user = userEvent.setup()
    renderFilters()

    expect(
      screen.getByRole('button', { name: 'hub:filters.label' })
    ).not.toHaveTextContent(/\d/)
    await openFilters(user)

    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'hub:fitFilterLabel' })
    ).not.toBeInTheDocument()
  })

  it('clears every filter at once, and only offers to when one is on', async () => {
    const user = userEvent.setup()
    const onShowOnlyDownloadedChange = vi.fn()
    useModelLikes.setState({ onlyLiked: true })
    const { onChange } = renderFilters(
      { uncensored: true },
      { showOnlyDownloaded: false, onShowOnlyDownloadedChange }
    )

    // Liked, Uncensored and the device fit.
    expect(
      screen.getByRole('button', { name: 'hub:filters.label' })
    ).toHaveTextContent('3')
    await openFilters(user)
    await user.click(
      screen.getByRole('menuitem', { name: 'hub:filters.clear' })
    )

    expect(useModelLikes.getState().onlyLiked).toBe(false)
    // Installed was off: nothing to turn off there.
    expect(onShowOnlyDownloadedChange).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        engine: undefined,
        uncensored: false,
        onlyFitting: false,
      })
    )
    await openFilters(user)
    expect(
      screen.getByRole('menuitem', { name: 'hub:filters.clear' })
    ).toHaveAttribute('aria-disabled', 'true')
  })

  it('names the current sort on its trigger and switches on selection', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    const trigger = screen.getByRole('button', { name: /hub:sortBy/ })
    expect(trigger).toHaveTextContent('hub:sort')
    expect(trigger).toHaveAttribute('title', 'hub:sortRecommended')

    const menu = await openSortMenu(user)
    expect(within(menu).getByText('hub:sortModels')).toBeInTheDocument()
    await user.click(
      within(menu).getByRole('menuitemradio', { name: 'hub:sortDownloads' })
    )

    expect(screen.getByRole('button', { name: /hub:sortBy/ })).toHaveAttribute(
      'title',
      'hub:sortDownloads'
    )
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'downloads' })
    )
  })

  it('hides the Likes sort when the data carries no likes', async () => {
    const user = userEvent.setup()
    renderFilters()

    const menu = await openSortMenu(user)

    expect(
      within(menu).getByRole('menuitemradio', { name: 'hub:sortDownloads' })
    ).toBeInTheDocument()
    expect(
      within(menu).queryByRole('menuitemradio', { name: 'hub:sortLikes' })
    ).not.toBeInTheDocument()
  })

  it('offers the Likes sort once like counts exist', async () => {
    const user = userEvent.setup()
    renderFilters({}, { showLikesSort: true })

    const menu = await openSortMenu(user)

    expect(
      within(menu).getByRole('menuitemradio', { name: 'hub:sortLikes' })
    ).toBeInTheDocument()
  })
})
