import { render, screen } from '@testing-library/react'
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

import { HubFilters } from '../HubFilters'

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

const openSortMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /hub:sortBy/ }))
  return screen.findByRole('menu')
}

describe('HubFilters', () => {
  beforeEach(() => {
    hardware.state.hardwareData = {
      cpu: { name: 'Apple M4 Max' },
      os_name: 'macOS 26',
      total_memory: 32 * 1024,
      gpus: [],
    }
  })

  it('shows the current sort and switches on selection', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    const trigger = screen.getByRole('button', { name: /hub:sortBy/ })
    expect(trigger).toHaveTextContent('hub:sortRecommended')

    await openSortMenu(user)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'hub:sortDownloads' }))

    expect(
      screen.getByRole('button', { name: /hub:sortBy/ })
    ).toHaveTextContent('hub:sortDownloads')
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'downloads' })
    )
  })

  it('hides the Likes option when the data carries no likes', async () => {
    const user = userEvent.setup()
    renderFilters()

    await openSortMenu(user)

    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:sortDownloads' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'hub:sortLikes' })
    ).not.toBeInTheDocument()
  })

  it('offers the Likes option once like counts exist', async () => {
    const user = userEvent.setup()
    renderFilters({}, { showLikesSort: true })

    await openSortMenu(user)

    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:sortLikes' })
    ).toBeInTheDocument()
  })

  it('carries the device filter inside the sort menu, on by default', async () => {
    const user = userEvent.setup()
    renderFilters()

    await openSortMenu(user)

    const item = screen.getByRole('menuitemcheckbox', {
      name: 'hub:fitFilterLabel',
    })
    expect(item).toBeChecked()
  })

  it('turns the device filter off and keeps the menu open', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    await openSortMenu(user)
    const item = screen.getByRole('menuitemcheckbox', {
      name: 'hub:fitFilterLabel',
    })
    await user.click(item)

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ onlyFitting: false })
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:fitFilterLabel' })
    ).not.toBeChecked()
  })

  it('carries the downloaded filter inside the sort menu', async () => {
    const user = userEvent.setup()
    const onShowOnlyDownloadedChange = vi.fn()
    const { onChange } = renderFilters(
      {},
      { showOnlyDownloaded: false, onShowOnlyDownloadedChange }
    )

    await openSortMenu(user)
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
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:fitFilterLabel' })
    ).toBeInTheDocument()
  })

  it('turns off the downloaded filter when device fit is selected', async () => {
    const user = userEvent.setup()
    const onShowOnlyDownloadedChange = vi.fn()
    renderFilters(
      { onlyFitting: false },
      { showOnlyDownloaded: true, onShowOnlyDownloadedChange }
    )

    await openSortMenu(user)
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

    await openSortMenu(user)

    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'hub:fitFilterLabel' })
    ).not.toBeInTheDocument()
  })

  it('omits the format picker where MLX cannot run', () => {
    // IS_MACOS is false in the vitest define block, so GGUF is the only
    // format and a picker would be a control that can never change anything.
    renderFilters()

    expect(
      screen.queryByRole('button', { name: 'hub:formats' })
    ).not.toBeInTheDocument()
  })

  it('carries the uncensored filter inside the sort menu, off by default', async () => {
    const user = userEvent.setup()
    renderFilters()

    // Tracker Task 24: it lives with the other filters, not beside the menu.
    expect(
      screen.queryByRole('checkbox', { name: 'hub:uncensored' })
    ).not.toBeInTheDocument()

    await openSortMenu(user)

    const item = screen.getByRole('menuitemcheckbox', { name: 'hub:uncensored' })
    expect(item).not.toBeChecked()
    expect(item).toHaveAttribute('title', 'hub:uncensoredHint')
  })

  it('narrows to uncensored builds and keeps the menu open', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    await openSortMenu(user)
    await user.click(
      screen.getByRole('menuitemcheckbox', { name: 'hub:uncensored' })
    )

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ uncensored: true })
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:uncensored' })
    ).toBeChecked()
  })
})

describe('HubFilters: more sorts and capability filters (the user, 2026-09-14)', () => {
  it('offers every sort both ways', async () => {
    const user = userEvent.setup()
    renderFilters({}, { showLikesSort: true })

    await openSortMenu(user)

    for (const key of [
      'hub:sortDownloads',
      'hub:sortDownloadsAsc',
      'hub:sortLikes',
      'hub:sortLikesAsc',
      'hub:sortLastModified',
      'hub:sortLastModifiedAsc',
      'hub:sortSizeAsc',
      'hub:sortSizeDesc',
      'hub:sortNameAsc',
      'hub:sortNameDesc',
    ]) {
      expect(screen.getByRole('menuitemcheckbox', { name: key })).toBeInTheDocument()
    }
  })

  it('hides both Likes sorts when there are no likes', async () => {
    const user = userEvent.setup()
    renderFilters()

    await openSortMenu(user)

    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'hub:sortLikesAsc' })
    ).not.toBeInTheDocument()
  })

  it('sorts smallest file first', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    await openSortMenu(user)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'hub:sortSizeAsc' }))

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'size-asc' })
    )
    expect(
      screen.getByRole('button', { name: /hub:sortBy/ })
    ).toHaveTextContent('hub:sortSizeAsc')
  })

  it('lists each capability with a tick box and its neon badge', async () => {
    const user = userEvent.setup()
    renderFilters()

    await openSortMenu(user)

    for (const [label, colour] of [
      ['Vision', 'amber'],
      ['Tool Use', 'blue'],
      ['Reasoning', 'fuchsia'],
      ['Audio', 'teal'],
      ['Coding', 'lime'],
      ['Multilingual', 'rose'],
    ]) {
      const item = screen.getByRole('menuitemcheckbox', { name: label })
      expect(item).not.toBeChecked()
      expect(item).toHaveClass(
        'data-[state=checked]:[&>span:first-child]:bg-primary'
      )
      expect(screen.getByText(label)).toHaveClass(`dark:text-${colour}-200`)
    }
  })

  it('ticks capabilities, keeps the menu open and shows how many are on', async () => {
    const user = userEvent.setup()
    const { onChange } = renderFilters()

    await openSortMenu(user)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Tool Use' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Vision' }))

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ capabilities: ['tools', 'vision'] })
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Tool Use' })
    ).toBeChecked()
    expect(screen.getByTestId('hub-capability-count')).toHaveTextContent('2')

    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Tool Use' }))
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ capabilities: ['vision'] })
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Tool Use' })
    ).not.toBeChecked()
  })
})

describe('HubFilters: tick boxes and search (the user, 2026-09-15)', () => {
  it('ticks the current sort and moves the tick when another is picked', async () => {
    const user = userEvent.setup()
    renderFilters()

    await openSortMenu(user)
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:sortRecommended' })
    ).toBeChecked()

    await user.click(screen.getByRole('menuitemcheckbox', { name: 'hub:sortNameAsc' }))
    await openSortMenu(user)

    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:sortNameAsc' })
    ).toBeChecked()
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'hub:sortRecommended' })
    ).not.toBeChecked()
  })

  it('narrows the whole menu to what the search matches', async () => {
    const user = userEvent.setup()
    renderFilters()

    await openSortMenu(user)
    await user.type(screen.getByRole('textbox', { name: 'hub:menuSearch' }), 'vis')

    expect(screen.getByRole('menuitemcheckbox', { name: 'Vision' })).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'Tool Use' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'hub:sortDownloads' })
    ).not.toBeInTheDocument()
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    renderFilters()

    await openSortMenu(user)
    await user.type(screen.getByRole('textbox', { name: 'hub:menuSearch' }), 'zzzz')

    expect(screen.getByText('hub:menuNoMatches')).toBeInTheDocument()
  })
})
