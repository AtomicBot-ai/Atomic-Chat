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
    await user.click(screen.getByRole('menuitem', { name: 'hub:sortDownloads' }))

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
      screen.getByRole('menuitem', { name: 'hub:sortDownloads' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'hub:sortLikes' })
    ).not.toBeInTheDocument()
  })

  it('offers the Likes option once like counts exist', async () => {
    const user = userEvent.setup()
    renderFilters({}, { showLikesSort: true })

    await openSortMenu(user)

    expect(
      screen.getByRole('menuitem', { name: 'hub:sortLikes' })
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
})
