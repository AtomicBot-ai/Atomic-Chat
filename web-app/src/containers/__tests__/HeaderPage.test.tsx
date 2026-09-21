import { render, screen } from '@testing-library/react'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { useLeftPanel } from '@/hooks/useLeftPanel'
import HeaderPage from '../HeaderPage'

describe('HeaderPage sidebar restore control', () => {
  beforeAll(() => {
    vi.stubGlobal('IS_MACOS', true)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    useLeftPanel.setState({ open: false })
  })

  it('keeps the collapsed toggle and header content in one aligned macOS row', () => {
    render(
      <HeaderPage>
        <div data-testid="header-content">Search</div>
      </HeaderPage>
    )

    const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })
    const content = screen.getByTestId('header-content')
    const row = toggle.parentElement

    expect(toggle).toHaveClass('shrink-0')
    expect(toggle).not.toHaveClass('absolute')
    expect(row).toHaveClass('items-center', 'gap-2')
    expect(row).toContainElement(content)
    expect(row?.parentElement).toHaveClass('pl-20')
  })

  it('returns to the regular inset when the sidebar is open', () => {
    useLeftPanel.setState({ open: true })
    const { container } = render(<HeaderPage>Search</HeaderPage>)

    expect(
      screen.queryByRole('button', { name: 'Toggle sidebar' })
    ).toBeNull()
    expect(container.firstElementChild).toHaveClass('pl-4')
    expect(container.firstElementChild).not.toHaveClass('pl-20')
  })
})
