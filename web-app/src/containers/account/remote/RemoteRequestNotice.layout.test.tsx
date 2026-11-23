import { act, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown
  }) => select({ location: { pathname: '/' } }),
}))

vi.mock('@/lib/notifications', () => ({
  isWindowAway: () => false,
  desktopNotificationsEnabled: () => true,
  showDesktopNotification: async () => {},
}))

const platform = vi.hoisted(() => ({ accounts: true }))
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
import { EMPTY_REMOTE_STATUS } from '@/services/account/remote-types'
import {
  resetAccountRemoteStoreForTests,
  useAccountRemoteStore,
} from '@/stores/account-remote-store'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { RemoteRequestNotice } from './RemoteRequestNotice'

const LONG_DEVICE =
  'DESKTOP-OFFICE-WORKSTATION-WITH-A-VERY-LONG-MACHINE-NAME-0042'

beforeEach(() => {
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
          it('keeps a long device name on one line inside the corner card', async () => {
            await page.viewport(width, 800)
            await i18n.changeLanguage(language)
            setFontSize(font)
            setTheme(theme)
            render(withTranslations(<RemoteRequestNotice />))
            act(() =>
              useAccountRemoteStore.getState().setStatus({
                ...EMPTY_REMOTE_STATUS,
                sharing: true,
                requests: [
                  {
                    grantId: 'r1',
                    deviceName: LONG_DEVICE,
                    platform: 'windows',
                    clientType: 'desktop',
                    checkCode: '936468',
                    createdAt: '2026-11-23T10:00:00Z',
                  },
                  {
                    grantId: 'r2',
                    deviceName: null,
                    platform: 'ios',
                    clientType: 'mobile',
                    checkCode: '482915',
                    createdAt: '2026-11-23T10:01:00Z',
                  },
                ],
              })
            )
            const card = await screen.findByTestId('remote-request-notice')
            await settle()

            expectNoHorizontalOverflow(card)
            expect(card.getBoundingClientRect().right).toBeLessThanOrEqual(
              window.innerWidth
            )
            expectOneLine(screen.getByText(LONG_DEVICE))
            expectOneLine(
              screen.getByText(
                i18n.t('account:remote.notice.checkCode', { code: '936468' })
              )
            )
          })
        })
      }
    }
  }
}
