import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

// Geometry only: the server is never started here.
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'stopped',
    isRunning: false,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => <a className={className}>{children}</a>,
  useNavigate: () => vi.fn(),
}))

import { ServerControlPanel } from '@/containers/ServerControlPanel'
import { useOnboardingStore } from '@/stores/onboarding-store'

// The Server sidebar the panel sits in.
const SIDEBAR_WIDTH = 256

function renderPanel() {
  render(
    withTranslations(
      <div style={{ width: SIDEBAR_WIDTH }} data-testid="sidebar">
        <ServerControlPanel />
      </div>
    )
  )
  return screen.getByTestId('sidebar')
}

const hint = () => screen.getByRole('region', { name: 'Setup guidance' })

describe('the Start hint in the server panel', () => {
  beforeEach(() => {
    const store = useOnboardingStore.getState()
    store.reset()
    store.begin('full', 'server')
    store.enqueue({
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: 'Qwen3.5-4B-Q4_K_M',
      phase: 'running',
    })
    store.handOff('endpoint')
    store.setGuide({ path: 'endpoint', hint: 2 })
  })

  afterEach(() => {
    setFontSize(DEFAULT_FONT_SIZE)
    setTheme('light')
  })

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'fits the sidebar above Start, its note and Skip guide inside it (%s)',
    async (fontSize) => {
      setFontSize(fontSize)
      const sidebar = renderPanel()
      await settle(sidebar)

      expectNoHorizontalOverflow(sidebar)
      expect(screen.getByText(/Your model is downloading/)).toBeVisible()
      expectFits(screen.getByRole('button', { name: 'Skip guide' }), hint())
      const start = screen.getByTestId('server-panel-power')
      expect(start.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        hint().getBoundingClientRect().bottom
      )
      expectFits(start, sidebar)
    }
  )

  it('follows the theme', async () => {
    const sidebar = renderPanel()
    await settle(sidebar)
    const colours = () => ({
      background: getComputedStyle(hint()).backgroundColor,
      title: getComputedStyle(hint().querySelector('h3')!).color,
    })

    const light = colours()
    setTheme('dark')
    const dark = colours()

    // The prototype's dark palette, and something else in light.
    expect(dark).toEqual({
      background: 'rgb(36, 54, 47)',
      title: 'rgb(237, 245, 240)',
    })
    expect(light.background).not.toBe(dark.background)
    expect(light.title).not.toBe(dark.title)
  })
})
