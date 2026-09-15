import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { WindowFrame } from '../WindowFrame'

const chrome = vi.hoisted(() => ({ hasCustomWindowChrome: vi.fn() }))
vi.mock('@/lib/window-chrome', () => chrome)

const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    ...appWindow,
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
    appWindow.minimize.mockReset()
    appWindow.toggleMaximize.mockReset()
    appWindow.close.mockReset()
  })

  // Pop-up windows and drop-down menus switch off clicks on the whole page
  // (`pointer-events: none` on <body>) while they are open. The strip lives in
  // the page, so Minimize, Maximize and Close went dead with them - on every
  // page that had a menu or a pop-up open (2026-09-14).
  it('keeps Minimize, Maximize and Close working while a pop-up is open', async () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)
    const user = userEvent.setup()

    const { container } = render(
      <WindowFrame>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Settings pop-up</DialogTitle>
          </DialogContent>
        </Dialog>
      </WindowFrame>
    )

    await waitFor(() =>
      expect(document.body.style.pointerEvents).toBe('none')
    )
    // The pop-up has a Close button of its own; these are the window's.
    const strip = within(
      container.querySelector('[data-window-chrome] > div') as HTMLElement
    )
    await user.click(strip.getByRole('button', { name: 'Minimize', hidden: true }))
    await user.click(strip.getByRole('button', { name: 'Maximize', hidden: true }))
    await user.click(strip.getByRole('button', { name: 'Close', hidden: true }))

    expect(appWindow.minimize).toHaveBeenCalledTimes(1)
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1)
    expect(appWindow.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the window buttons working while a drop-down menu is open', async () => {
    chrome.hasCustomWindowChrome.mockReturnValue(true)
    const user = userEvent.setup()

    render(
      <WindowFrame>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Options</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Rename</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </WindowFrame>
    )

    await waitFor(() =>
      expect(document.body.style.pointerEvents).toBe('none')
    )
    await user.click(screen.getByRole('button', { name: 'Minimize', hidden: true }))

    expect(appWindow.minimize).toHaveBeenCalledTimes(1)
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
