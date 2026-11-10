import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'

import type {
  AccountService,
  AccountSession,
  AccountStatus,
} from '@/services/account/types'
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
import { AccountPage } from './AccountPage'

const RAIL = 60
const SIDEBAR = 240

// Worst-case copy: a long name, a long address and a long device name.
const user = {
  id: 'u1',
  email: 'ada.augusta.king.countess.of.lovelace@analytical-engine.example.com',
  displayName: 'Augusta Ada King, Countess of Lovelace and Analyst',
  avatarUrl: null,
}
const session = (over: Partial<AccountSession>): AccountSession => ({
  id: 's',
  clientType: 'desktop',
  deviceName: null,
  platform: 'windows',
  appVersion: '2.4.0-rc.12',
  authMethod: 'google',
  createdAt: '2026-11-01T10:00:00Z',
  lastUsedAt: '2026-10-01T10:00:00Z',
  expiresAt: '2026-12-01T10:00:00Z',
  current: false,
  ...over,
})

function seed(status: AccountStatus) {
  seedServiceHub({
    account: {
      status: vi.fn(async () => status),
      onChanged: vi.fn(async () => () => {}),
      providers: vi.fn(async () => ['email', 'google']),
      profile: vi.fn(async () => ({
        user,
        createdAt: '2026-11-01T10:00:00Z',
        identities: [
          { provider: 'google', email: 'ada@gmail.example.com', createdAt: '' },
          { provider: 'email', email: user.email, createdAt: '' },
        ],
      })),
      sessions: vi.fn(async () => [
        session({ id: 'a', current: true, deviceName: 'MacBook Pro' }),
        session({
          id: 'b',
          deviceName:
            'DESKTOP-OFFICE-WORKSTATION-WITH-A-VERY-LONG-MACHINE-NAME-0042',
        }),
        session({ id: 'c', platform: null }),
      ]),
    } as unknown as AccountService,
  })
}

beforeEach(() => resetAccountStore())

afterEach(async () => {
  await page.viewport(1280, 800)
})

for (const width of [1024, 1280]) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const theme of ['light', 'dark'] as const) {
      describe(`${width}px / ${font} / ${theme}`, () => {
        it('keeps the signed-in page inside the settings column', async () => {
          await page.viewport(width, 900)
          setFontSize(font)
          setTheme(theme)
          seed({ signedIn: true, user })
          render(
            withTranslations(
              <main
                style={{ width: width - RAIL - SIDEBAR }}
                className="flex flex-col gap-3 p-4"
                data-testid="page"
              >
                <AccountPage />
              </main>
            )
          )
          const rows = await screen.findAllByTestId('account-device')
          await screen.findByText(/Google · ada@gmail/)
          await settle()

          expectNoHorizontalOverflow(screen.getByTestId('page'))
          // One stable action column, whether a row has Sign out or not.
          expectSameWidth(rows.map((row) => row.lastElementChild!))
          expect(rows).toHaveLength(3)
        })

        it('keeps the sign-in form inside the settings column', async () => {
          await page.viewport(width, 900)
          setFontSize(font)
          setTheme(theme)
          seed({ signedIn: false, user: null })
          render(
            withTranslations(
              <main
                style={{ width: width - RAIL - SIDEBAR }}
                className="flex flex-col gap-3 p-4"
                data-testid="page"
              >
                <AccountPage />
              </main>
            )
          )
          await screen.findByRole('button', { name: 'Continue with Google' })
          await settle()

          expectNoHorizontalOverflow(screen.getByTestId('page'))
        })
      })
    }
  }
}
