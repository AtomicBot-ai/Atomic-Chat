import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import HeaderPage from '../HeaderPage'

const chrome = vi.hoisted(() => ({ hasCustomWindowChrome: vi.fn() }))
vi.mock('@/lib/window-chrome', () => chrome)

describe('HeaderPage', () => {
  beforeEach(() => {
    chrome.hasCustomWindowChrome.mockReset()
  })

  it('moves the window and keeps the corner clear for the window controls', () => {
    // Windows main window: no native title bar, so this row does its job.
    chrome.hasCustomWindowChrome.mockReturnValue(true)

    const { container } = render(
      <HeaderPage>
        <span>Page title</span>
      </HeaderPage>
    )

    const header = container.firstElementChild as HTMLElement
    expect(header).toHaveAttribute('data-tauri-drag-region')
    expect(header).toHaveClass('pr-40')
  })

  it('leaves both alone where the platform has its own title bar', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(false)

    const { container } = render(
      <HeaderPage>
        <span>Page title</span>
      </HeaderPage>
    )

    const header = container.firstElementChild as HTMLElement
    // IS_MACOS is false under vitest, so nothing else adds the region.
    expect(header).not.toHaveAttribute('data-tauri-drag-region')
    expect(header).not.toHaveClass('pr-40')
  })
})
