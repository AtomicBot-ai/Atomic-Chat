import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

// Geometry only: the server is never started or restarted here.
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'running',
    isRunning: true,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}))
vi.mock('@/hooks/useServiceHub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useServiceHub')>()),
  useServiceHub: () => ({}),
}))

import { ServerConfiguration } from './ServerConfiguration'

// Server → Configuration's content column at a 1024 px window: the window
// less the 60 px rail, the 256 px sidebar and the page's padding.
const COLUMN_WIDTH = 676

function renderAt(width: number) {
  render(
    withTranslations(
      <div className="server-page" style={{ width }} data-testid="page">
        <ServerConfiguration />
      </div>
    )
  )
  return screen.getByTestId('page')
}

const top = (element: Element) => element.getBoundingClientRect().top

describe('Server configuration form', () => {
  afterEach(() => setFontSize(DEFAULT_FONT_SIZE))

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'keeps port and prefix side by side, the key actions and the save bar inside the column (%s)',
    async (fontSize) => {
      setFontSize(fontSize)
      const page = renderAt(COLUMN_WIDTH)
      // The save bar shows once there is something to save.
      fireEvent.change(screen.getByLabelText('Port'), {
        target: { value: '8080' },
      })
      await settle(page)

      expectNoHorizontalOverflow(page)
      expect(top(screen.getByLabelText('API prefix'))).toBe(
        top(screen.getByLabelText('Port'))
      )
      for (const name of ['Generate key', 'Discard', 'Save changes']) {
        const button = screen.getByRole('button', { name })
        // One line of label in the 36 px control, not a wrapped one.
        expect(button.getBoundingClientRect().height).toBeCloseTo(36, 0)
        expectFits(button, page)
      }
    }
  )

  it('drops the host list under its field, as wide as the field', async () => {
    const page = renderAt(COLUMN_WIDTH)
    await settle(page)
    const host = screen.getByRole('button', { name: 'Server host' })

    await userEvent.click(host)
    const menu = await screen.findByRole('menu')
    await settle(page)

    const field = host.getBoundingClientRect()
    const list = menu.getBoundingClientRect()
    // Under the field, not over it as the macOS select popup sits.
    expect(list.top).toBeGreaterThanOrEqual(field.bottom)
    expect(list.width).toBeCloseTo(field.width, 0)
    expect(list.left).toBeCloseTo(field.left, 0)
  })

  it('stacks port above prefix in a narrow column', async () => {
    const page = renderAt(440)
    await settle(page)

    expectNoHorizontalOverflow(page)
    expect(top(screen.getByLabelText('API prefix'))).toBeGreaterThan(
      top(screen.getByLabelText('Port'))
    )
  })
})
