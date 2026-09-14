import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    title: vi.fn().mockResolvedValue('Radium'),
  }),
}))

vi.mock('@/lib/tauriEvent', () => ({
  createSafeUnlisten: (unlisten: () => void | Promise<void>) => async () => {
    await unlisten()
  },
}))

describe('WindowFrame', () => {
  beforeEach(() => {
    chrome.hasCustomWindowChrome.mockReset()
  })

  it('shows Minimize, Maximize and Close when the window has no native title bar', async () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)

    render(
      <WindowFrame>
        <p>app content</p>
      </WindowFrame>
    )

    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.getByText('app content')).toBeInTheDocument()
    // The title comes from the window itself, so it follows the product name.
    await waitFor(() => expect(screen.getByText('Radium')).toBeInTheDocument())
  })

  it('leaves the bar a drag region, so the window can still be moved', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)

    const { container } = render(
      <WindowFrame>
        <p>app content</p>
      </WindowFrame>
    )

    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull()
    // Marks the scope of the index.css rules that make room for the bar.
    expect(container.querySelector('[data-window-chrome]')).not.toBeNull()
  })

  it('keeps the strip slim, with no line under it', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)

    const { container } = render(
      <WindowFrame>
        <p>app content</p>
      </WindowFrame>
    )

    const strip = container.querySelector('[data-window-chrome] > div')
    expect(strip).toHaveClass('h-8')
    expect(strip).not.toHaveClass('border-b')
    // The app starts right under the strip.
    expect(screen.getByText('app content').parentElement).toHaveClass('pt-8')
  })

  it('adds nothing where the platform draws its own title bar', () => {
    chrome.hasCustomWindowChrome.mockReturnValue(false)

    const { container } = render(
      <WindowFrame>
        <p>app content</p>
      </WindowFrame>
    )

    expect(screen.getByText('app content')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Close' })
    ).not.toBeInTheDocument()
    expect(container.querySelector('[data-tauri-drag-region]')).toBeNull()
    expect(container.querySelector('[data-window-chrome]')).toBeNull()
  })
})
