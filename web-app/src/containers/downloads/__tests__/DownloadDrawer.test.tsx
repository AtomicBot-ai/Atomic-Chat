/**
 * The download drawer is a plain list now.
 *
 * It used to be a canvas of Tetris-style falling blocks behind coloured tabs,
 * animated every frame for as long as anything was downloading - drawer open
 * or not - and it opened by itself, which on a fresh install put engine
 * downloads nobody asked for over the onboarding screen.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(' ')}` : key,
  }),
}))

const toast = vi.fn()
vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toast(...args) }))

import { SidebarProvider } from '@/components/ui/sidebar'
import { useDownloadDrawer } from '@/stores/download-drawer-store'
import { DownloadDrawer } from '../DownloadDrawer'
import { DownloadPanel } from '../DownloadPanel'
import type { DownloadRowProps } from '../DownloadProgressRow'

const model: DownloadRowProps = {
  id: 'unsloth/Qwen3-8B-GGUF',
  name: 'unsloth/Qwen3-8B-GGUF',
  progress: 0.25,
  current: 1_000_000_000,
  total: 4_000_000_000,
  bytesPerSecond: 40_000_000,
  pausable: true,
  onPause: vi.fn(),
  onCancel: vi.fn(),
}

const engine: DownloadRowProps = {
  id: 'llamacpp-backend-b11463/win-cuda-12.4-x64',
  progress: 0.62,
  current: 62,
  total: 100,
  onCancel: vi.fn(),
}

function renderDrawer() {
  return render(
    <SidebarProvider>
      <DownloadDrawer />
    </SidebarProvider>
  )
}

describe('DownloadDrawer', () => {
  beforeEach(() => {
    useDownloadDrawer.setState({ items: [], open: false })
    toast.mockClear()
  })
  afterEach(() => vi.clearAllMocks())

  it('draws no canvas and runs no animation loop', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    useDownloadDrawer.setState({ items: [model, engine], open: true })
    const { container } = renderDrawer()
    expect(container.querySelector('canvas')).toBeNull()
    expect(screen.queryByTestId('falling-blocks')).toBeNull()
    expect(raf).not.toHaveBeenCalled()
  })

  it('lists what the user started with its real figures, and engine builds as one quiet line', () => {
    useDownloadDrawer.setState({ items: [model, engine], open: true })
    renderDrawer()

    const list = screen.getByTestId('download-list')
    expect(list.querySelectorAll('li')).toHaveLength(1)
    expect(list.textContent).toContain('Qwen3')
    expect(list.textContent).toMatch(/25%/)

    const engineRow = screen.getByTestId('engine-download-row')
    expect(engineRow.textContent).toContain('win-cuda-12.4-x64')
    expect(engineRow.textContent).toContain('62%')
    // No pause for an engine build; cancel works.
    expect(engineRow.querySelector('[aria-label="common:pauseDownload"]')).toBeNull()
    fireEvent.click(engineRow.querySelector('[aria-label="common:cancelDownload"]')!)
    expect(engine.onCancel).toHaveBeenCalledOnce()
  })

  it('stays closed until the user opens it', () => {
    renderDrawer()
    act(() => useDownloadDrawer.getState().setItems([model]))
    expect(screen.getByTestId('download-drawer').getAttribute('aria-hidden')).toBe('true')
  })

  it('announces a download the user started with a toast that opens the drawer', () => {
    render(<DownloadPanel items={[model, engine]} />)
    expect(toast).toHaveBeenCalledTimes(1)
    const [message, options] = toast.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ]
    expect(message).toContain('Qwen3')
    act(() => options.action.onClick())
    expect(useDownloadDrawer.getState().open).toBe(true)
  })

  it('announces each download once, and engine builds never', () => {
    const { rerender } = render(<DownloadPanel items={[engine]} />)
    rerender(<DownloadPanel items={[engine, { ...model, progress: 0.3 }]} />)
    rerender(<DownloadPanel items={[engine, { ...model, progress: 0.4 }]} />)
    const messages = toast.mock.calls.map(([message]) => String(message))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Qwen3')
    expect(messages[0]).not.toContain('win-cuda')
  })
})
