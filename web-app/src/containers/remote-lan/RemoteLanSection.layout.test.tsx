import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { withTranslations } from '@/test/layout'

// Static views: the geometry, not the tunnel or the LAN bind, is under test.
// Remote carries the API key block, LAN only its switch, so Remote is taller.
vi.mock('@/hooks/useRemoteAccess', () => ({
  useRemoteAccess: () => ({
    tone: 'idle',
    stateKey: 'settings:remoteLan.state.off',
    action: 'start',
    busy: false,
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
// plain browser, so switch it on to lay out the desktop pair of cards.
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
    busy: false,
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

const heightOf = (element: Element) => element.getBoundingClientRect().height

/** `settle()` without waiting on animations: the status dot pulses forever. */
async function painted(): Promise<void> {
  await document.fonts.ready
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

describe('Remote and LAN access cards', () => {
  it('share the row height side by side, so the shorter one leaves no hole', async () => {
    // The API screen's content column at a 1280 px window.
    render(
      withTranslations(
        <div style={{ width: 1030 }}>
          <RemoteLanSection server={server} />
        </div>
      )
    )
    await painted()

    const remote = screen.getByRole('region', { name: /remote access/i })
    const lan = screen.getByRole('region', { name: /lan access/i })
    const remoteCard = remote.firstElementChild!
    const lanCard = lan.firstElementChild!
    // Side by side at this width (the grid's `lg` breakpoint).
    expect(remote.getBoundingClientRect().top).toBe(
      lan.getBoundingClientRect().top
    )
    expect(
      Math.abs(heightOf(remoteCard) - heightOf(lanCard))
    ).toBeLessThanOrEqual(1)
  })
})
