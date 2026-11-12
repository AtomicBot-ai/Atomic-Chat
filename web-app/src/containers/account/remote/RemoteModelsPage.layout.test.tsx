import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    start: async () => {},
    stop: async () => {},
    status: 'running',
  }),
}))

const platform = vi.hoisted(() => ({
  accounts: true,
  localApiServer: true,
  remoteAccess: true,
}))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key in platform
          ? platform[key as keyof typeof platform]
          : target[key as keyof typeof target],
    }),
  }
})

import i18n from '@/i18n/setup'
import {
  EMPTY_REMOTE_STATUS,
  type RemoteStatus,
} from '@/services/account/remote-types'
import type { AccountService } from '@/services/account/types'
import { resetAccountRemoteStoreForTests } from '@/stores/account-remote-store'
import { resetAccountStore } from '@/stores/account-store'
import { seedServiceHub } from '@/test/service-hub'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectSameWidth,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { RemoteModelsPage } from './RemoteModelsPage'

// The account section: the rail, then its sidebar, then the page.
const RAIL = 60
const SIDEBAR = 240

const LONG_DEVICE =
  'DESKTOP-OFFICE-WORKSTATION-WITH-A-VERY-LONG-MACHINE-NAME-0042'
const LONG_HOST =
  "Augusta's Mac Studio in the upstairs office (M3 Ultra, 512 GB)"

// Worst case: requests, devices, every connection state, long names.
const status: RemoteStatus = {
  ...EMPTY_REMOTE_STATUS,
  sharing: true,
  host: { id: 'self', name: 'MacBook' },
  reach: {
    serverRunning: true,
    serverHasKey: false,
    tunnel: 'online',
    lan: true,
  },
  hostError: 'network: cannot reach the account service: connection refused',
  requests: [
    {
      grantId: 'r1',
      deviceName: LONG_DEVICE,
      platform: 'windows',
      clientType: 'desktop',
      checkCode: '936468',
      createdAt: '2026-11-12T10:00:00Z',
    },
  ],
  devices: [
    {
      grantId: 'd1',
      deviceName: LONG_DEVICE,
      platform: 'windows',
      issuedAt: 1,
    },
    { grantId: 'd2', deviceName: null, platform: 'ios', issuedAt: 1 },
  ],
  connections: [
    {
      grantId: 'c1',
      hostId: 'h1',
      hostName: LONG_HOST,
      status: 'pending',
      ready: false,
      via: null,
      checkCode: '482915',
    },
    {
      grantId: 'c2',
      hostId: 'h2',
      hostName: 'Studio',
      status: 'active',
      ready: true,
      via: 'lan',
      checkCode: null,
    },
  ],
}

const host = (id: string, name: string, online: boolean) => ({
  id,
  name,
  clientType: id === 'h3' ? 'server' : 'desktop',
  platform: 'macos',
  online,
  tunnelState: online ? 'online' : null,
  lanEnabled: true,
  lastSeenAt: '2026-11-10T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  isSelf: false,
  myGrant: null,
})

function seed() {
  seedServiceHub({
    account: {
      status: vi.fn(async () => ({
        signedIn: true,
        user: {
          id: 'u1',
          email: 'ada@example.com',
          displayName: 'Ada',
          avatarUrl: null,
        },
      })),
      onChanged: vi.fn(async () => () => {}),
      remoteStatus: vi.fn(async () => status),
      onRemoteChanged: vi.fn(async () => () => {}),
      onRemoteConnectionEnded: vi.fn(async () => () => {}),
      remoteHosts: vi.fn(async () => [
        host('h1', LONG_HOST, true),
        host('h2', 'Studio', true),
        host('h3', 'home-server-in-the-garage-rack', false),
      ]),
    } as unknown as AccountService,
  })
}

beforeEach(() => {
  resetAccountStore()
  resetAccountRemoteStoreForTests()
})

afterEach(async () => {
  await page.viewport(1280, 800)
  await i18n.changeLanguage('en')
})

for (const language of ['en', 'ru']) {
  for (const width of [1024, 1280]) {
    for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
      for (const theme of ['light', 'dark'] as const) {
        describe(`${language} / ${width}px / ${font} / ${theme}`, () => {
          it('keeps both cards inside the page column', async () => {
            await page.viewport(width, 900)
            await i18n.changeLanguage(language)
            setFontSize(font)
            setTheme(theme)
            seed()
            render(
              withTranslations(
                <main
                  style={{ width: width - RAIL - SIDEBAR }}
                  className="flex flex-col gap-3 p-4"
                  data-testid="page"
                >
                  <RemoteModelsPage />
                </main>
              )
            )
            const hosts = await screen.findAllByTestId('remote-host')
            await screen.findByTestId('remote-request')
            await settle()

            expectNoHorizontalOverflow(screen.getByTestId('page'))
            // Revoke sits in one column whatever the device's name.
            const devices = screen.getAllByTestId('remote-device')
            expectSameWidth(devices.map((row) => row.lastElementChild!))
            expect(hosts).toHaveLength(3)
          })
        })
      }
    }
  }
}
