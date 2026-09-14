import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useHeaderOverlay } from '@/stores/header-overlay-store'
import { WindowFrame } from '../WindowFrame'

const chrome = vi.hoisted(() => ({ hasCustomWindowChrome: vi.fn() }))
vi.mock('@/lib/window-chrome', () => chrome)

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
  }),
}))

vi.mock('@/lib/tauriEvent', () => ({
  createSafeUnlisten: (unlisten: () => void | Promise<void>) => async () => {
    await unlisten()
  },
}))

const renderFrame = () =>
  render(
    <WindowFrame>
      <p>app content</p>
    </WindowFrame>
  )

describe('WindowFrame', () => {
  beforeEach(() => {
    chrome.hasCustomWindowChrome.mockReset()
    useHeaderOverlay.getState().setRightOverlayButtons(0)
  })

  it('puts Minimize, Maximize and Close over the page, with no bar of its own', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)

    const { container } = renderFrame()

    const controls = screen.getByRole('group', { name: 'Window controls' })
    for (const name of ['Minimize', 'Maximize', 'Close']) {
      expect(controls).toContainElement(screen.getByRole('button', { name }))
    }
    expect(screen.getByText('app content')).toBeInTheDocument()
    // No title strip: the page's own header is what moves the window.
    expect(screen.queryByText('Radium')).not.toBeInTheDocument()
    expect(container.querySelector('[data-window-chrome]')).toBeNull()
    expect(container.querySelector('[data-tauri-drag-region]')).toBeNull()
  })

  it("sits just left of the chat's corner buttons, following how many there are", () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)

    renderFrame()
    const controls = screen.getByRole('group', { name: 'Window controls' })
    expect(controls).toHaveStyle({ right: '12px' })

    act(() => useHeaderOverlay.getState().setRightOverlayButtons(2))
    expect(controls).toHaveStyle({ right: '92px' })
  })

  it('adds nothing where the platform draws its own title bar', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(false)

    renderFrame()

    expect(screen.getByText('app content')).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Window controls' })
    ).not.toBeInTheDocument()
  })
})
