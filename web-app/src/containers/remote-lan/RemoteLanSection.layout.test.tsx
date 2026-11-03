import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

// Static views: the geometry, not the tunnel or the LAN bind, is under test.
vi.mock('@/hooks/useRemoteAccess', () => ({
  useRemoteAccess: () => ({
    tone: 'idle',
    stateKey: 'settings:remoteLan.state.off',
    action: 'start',
    busy: null,
    disabled: false,
    onAction: () => {},
    message: {
      key: 'settings:remoteLan.remote.noKeyWarning',
      tone: 'warning',
    },
    apiUrl: null,
    apiKey: '',
    hasApiKey: false,
    generateKey: () => {},
    keyNeedsRestart: false,
    restarting: false,
    restartDisabled: false,
    restartServer: () => {},
    autoStart: false,
    setAutoStart: () => {},
    confirmOpen: false,
    confirmGenerateKey: () => {},
    confirmWithoutKey: () => {},
    cancelConfirm: () => {},
  }),
}))
// Remote access is a desktop-Tauri feature (none on Windows arm64); this is a
// plain browser, so switch it on to lay out both desktop cards.
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  const { PlatformFeature } = await import('@/lib/platform/types')
  return {
    ...actual,
    PlatformFeatures: {
      ...actual.PlatformFeatures,
      [PlatformFeature.REMOTE_ACCESS]: true,
    },
  }
})
vi.mock('@/hooks/useLanAccess', () => ({
  useLanAccess: () => ({
    tone: 'idle',
    stateKey: 'settings:remoteLan.state.off',
    action: 'start',
    busy: null,
    disabled: false,
    onAction: () => {},
    message: null,
    urls: [],
    showRestartNote: true,
    showFirewallHint: false,
    autoStart: true,
    setAutoStart: () => {},
  }),
}))

import { RemoteLanSection } from './RemoteLanSection'

const server = {
  status: 'running',
  isRunning: true,
  isModelLoading: false,
  isBusy: false,
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
  refreshStatus: vi.fn(),
} as unknown as Parameters<typeof RemoteLanSection>[0]['server']

/** `settle()` without waiting on animations: the status dot pulses forever. */
async function painted(): Promise<void> {
  await document.fonts.ready
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

// Server → Remote access's content column at a 1024 px window: the window
// less the 60 px rail, the 256 px sidebar and the page's padding.
const COLUMN_WIDTH = 676

describe('Remote access and Local network cards', () => {
  afterEach(() => setFontSize(DEFAULT_FONT_SIZE))

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'stack in the page column at a 1024 px window without spilling (%s)',
    async (fontSize) => {
      setFontSize(fontSize)
      render(
        withTranslations(
          <div className="server-page" style={{ width: COLUMN_WIDTH }}>
            <RemoteLanSection server={server} />
          </div>
        )
      )
      await painted()

      const remote = screen.getByRole('region', { name: /remote access/i })
      const lan = screen.getByRole('region', { name: /local network/i })
      expect(lan.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        remote.getBoundingClientRect().bottom
      )
      for (const card of [remote, lan]) {
        expectNoHorizontalOverflow(card)
        const action = within(card).getByRole('button', { name: /^start /i })
        // One line of label in the 28 px control, not a wrapped one.
        expect(action.getBoundingClientRect().height).toBeCloseTo(28, 0)
        expectFits(action, card)
      }
    }
  )
})
