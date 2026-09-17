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

  it('pins the collapsed-sidebar toggle to the macOS traffic-light row', () => {
    render(<HeaderPage />)

    expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toHaveClass(
      'absolute',
      'left-20',
      'top-0'
    )
  })
})
