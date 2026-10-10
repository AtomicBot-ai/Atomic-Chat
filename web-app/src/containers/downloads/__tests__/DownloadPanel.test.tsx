import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DownloadPanel } from '../DownloadPanel'
import type { DownloadRowProps } from '../DownloadProgressRow'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

// The panel measures itself and the composer; jsdom has no ResizeObserver.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = MockResizeObserver
})

afterEach(() => {
  // A stale preference from older app versions must not affect later tests.
  // Guarded: Node 26 can leave storage unavailable without a file argument.
  try {
    window.localStorage.removeItem('download-panel-collapsed')
  } catch {
    // No storage in this runtime: nothing was remembered.
  }
})

const GB = 1024 ** 3

/** The one width the panel renders at; `panelLayout` assumes the same 352px. */
const PANEL_WIDTH_CLASS = 'w-[min(22rem,calc(100vw-2rem))]'

function row(
  id: string,
  over: Partial<DownloadRowProps> = {}
): DownloadRowProps {
  return {
    id,
    progress: 0.05,
    current: 0.05 * GB,
    total: GB,
    bytesPerSecond: 0,
    ...over,
  }
}

const three = [
  row('unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', {
    progress: 1,
    current: 12.4 * GB,
    total: 12.4 * GB,
    bytesPerSecond: 118.4 * 1024 * 1024,
    pausable: true,
  }),
  row('mlx-community/gemma-3-27b-it-4bit'),
  row('unsloth/Qwen3-4B-GGUF'),
]

/**
 * 2.0.39, Danny's test drive: "everything starts sliding onto two lines". The
 * card must keep one width whatever its rows say — three digits of percent,
 * a two-digit gigabyte pair, an hours-long estimate, a second download — so
 * the only thing that ever changes on screen is the text itself.
 */
describe('DownloadPanel width', () => {
  it('opens the first download despite a stale collapsed preference', () => {
    window.localStorage.setItem('download-panel-collapsed', 'true')

    render(<DownloadPanel items={[row('text-model-q4_k_m')]} />)

    expect(screen.getByRole('region')).toHaveClass(PANEL_WIDTH_CLASS)
    expect(
      screen.queryByLabelText('common:downloadPanel.expand')
    ).not.toBeInTheDocument()
  })

  it('is one fixed width, whatever the rows say', () => {
    const { rerender } = render(<DownloadPanel items={[row('a/one')]} />)
    expect(screen.getByRole('region')).toHaveClass(PANEL_WIDTH_CLASS)

    rerender(<DownloadPanel items={three} />)
    expect(screen.getByRole('region')).toHaveClass(PANEL_WIDTH_CLASS)
  })

  it('lists every running download and counts them in the header', () => {
    render(<DownloadPanel items={three} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(
      screen.getByText('Qwen3-Coder-30B-A3B-Instruct-GGUF')
    ).toBeInTheDocument()
    expect(screen.getByText('gemma-3-27b-it-4bit')).toBeInTheDocument()
    expect(screen.getByText('Qwen3-4B-GGUF')).toBeInTheDocument()
  })

  it('collapses to a badge that still counts the downloads', () => {
    render(<DownloadPanel items={three} />)

    fireEvent.click(screen.getByLabelText('common:downloadPanel.collapse'))

    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    const badge = screen.getByLabelText('common:downloadPanel.expand')
    expect(badge).toHaveTextContent('3')
    expect(badge.querySelector('span')).toHaveClass('bg-blue-500')
    expect(badge.querySelector('span')).not.toHaveClass('bg-emerald-500')

    fireEvent.click(badge)
    expect(screen.getByRole('region')).toHaveClass(PANEL_WIDTH_CLASS)
  })

  it('keeps an intentional collapse for the active run and expands the next run', () => {
    const textDownload = row('text-model-q4_k_m')
    const imageDownload = row('diffusion-model-flux:q4')
    const { rerender } = render(<DownloadPanel items={[textDownload]} />)

    fireEvent.click(screen.getByLabelText('common:downloadPanel.collapse'))
    rerender(<DownloadPanel items={[textDownload, imageDownload]} />)

    expect(
      screen.getByLabelText('common:downloadPanel.expand')
    ).toHaveTextContent('2')
    expect(screen.queryByRole('region')).not.toBeInTheDocument()

    rerender(<DownloadPanel items={[]} />)
    rerender(<DownloadPanel items={[imageDownload]} />)

    expect(screen.getByRole('region')).toHaveClass(PANEL_WIDTH_CLASS)
    expect(screen.getByTitle('diffusion-model-flux:q4')).toBeInTheDocument()
  })
})

/**
 * 2026-09-30 feedback: after the first message on the home screen the panel
 * sat over the new thread's composer until it was collapsed and expanded. The
 * thread mounts a composer of its own; the panel kept measuring the one that
 * had just left the page.
 */
describe('DownloadPanel placement', () => {
  /** A composer as wide as the content column, spanning the panel's corner. */
  function composer(top: number): HTMLElement {
    const element = document.createElement('div')
    element.setAttribute('data-composer-anchor', '')
    element.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + 100,
        left: 100,
        right: window.innerWidth - 24,
        height: 100,
        width: window.innerWidth - 124,
        x: 100,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect
    return element
  }

  afterEach(() => {
    document
      .querySelectorAll('[data-composer-anchor]')
      .forEach((element) => element.remove())
  })

  it('docks above the composer of a thread that replaced the home screen', async () => {
    // Centred on the home screen, with room for the panel beneath it.
    const home = composer(200)
    document.body.appendChild(home)
    render(<DownloadPanel items={[row('text-model-q4_k_m')]} />)
    expect(screen.getByRole('region').style.bottom).toBe('16px')

    // The first message opens the thread: its composer is pinned to the bottom.
    home.remove()
    const threadTop = window.innerHeight - 116
    document.body.appendChild(composer(threadTop))

    await waitFor(() =>
      expect(screen.getByRole('region').style.bottom).toBe(
        `${window.innerHeight - threadTop + 12}px`
      )
    )
  })
})
