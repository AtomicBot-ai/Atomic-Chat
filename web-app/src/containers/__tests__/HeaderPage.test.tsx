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

// The sidebar toggle and the traffic-light inset moved to the window title
// bar row, so a page header is the same whether the sidebar is open or not.
describe('HeaderPage', () => {
  beforeAll(() => {
    vi.stubGlobal('IS_MACOS', true)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    useLeftPanel.setState({ open: false })
  })

  it('offers no sidebar toggle of its own, even with the sidebar collapsed', () => {
    render(
      <HeaderPage>
        <div data-testid="header-content">Search</div>
      </HeaderPage>
    )

    expect(
      screen.queryByRole('button', { name: 'Toggle sidebar' })
    ).toBeNull()
    expect(screen.getByTestId('header-content')).toBeInTheDocument()
  })

  it('keeps the regular inset whether the sidebar is open or not', () => {
    const collapsed = render(<HeaderPage>Search</HeaderPage>)
    expect(collapsed.container.firstElementChild).toHaveClass('pl-4')
    expect(collapsed.container.firstElementChild).not.toHaveClass('pl-20')
    collapsed.unmount()

    useLeftPanel.setState({ open: true })
    const open = render(<HeaderPage>Search</HeaderPage>)
    expect(open.container.firstElementChild).toHaveClass('pl-4')
  })

  it('stays the window drag region on macOS', () => {
    const { container } = render(<HeaderPage>Search</HeaderPage>)
    expect(container.firstElementChild).toHaveAttribute(
      'data-tauri-drag-region'
    )
  })
})
