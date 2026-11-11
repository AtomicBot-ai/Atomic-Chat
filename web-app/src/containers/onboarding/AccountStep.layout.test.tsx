import '@/test/telemetry-ready'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@/i18n/setup'
import type { AccountService, AccountStatus } from '@/services/account/types'
import { resetAccountStore } from '@/stores/account-store'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectSameHeight,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { AccountStep } from './steps/AccountStep'
import './onboarding.css'

// Worst-case copy for the signed-in card: a long name and a long address.
const user = {
  id: 'u1',
  email: 'ada.augusta.king.countess.of.lovelace@analytical-engine.example.com',
  displayName: 'Augusta Ada King, Countess of Lovelace and Analyst',
  avatarUrl: null,
}

function seed(status: AccountStatus) {
  seedServiceHub({
    account: {
      status: vi.fn(async () => status),
      onChanged: vi.fn(async () => () => {}),
      providers: vi.fn(async () => ['email', 'google']),
      emailStart: vi.fn(async () => {
        throw { code: 'rate_limited', message: 'slow down', retryAfter: 600 }
      }),
      cancelLogin: vi.fn(async () => {}),
    } as unknown as AccountService,
  })
}

async function renderStep(status: AccountStatus) {
  seed(status)
  await act(async () => {
    render(
      withTranslations(
        <div className="ob-shell">
          <main className="ob-main">
            <div className="ob-content">
              <AccountStep next={vi.fn()} goTo={vi.fn()} handOff={vi.fn()} />
            </div>
          </main>
        </div>
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await settle(document.body)
}

beforeEach(() => resetAccountStore())

describe.each(['light', 'dark'] as const)('account step in %s', (theme) => {
  it.each(
    ['en', 'ru'].flatMap((language) =>
      [1024, 1280].flatMap((width) =>
        [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((font) => ({
          language,
          width,
          font,
        }))
      )
    )
  )(
    'fits at $width px with $font text in $language, errors included',
    async ({ language, width, font }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(font)
      await i18n.changeLanguage(language)
      await renderStep({ signedIn: false, user: null })

      const google = screen.getByRole('button', {
        name: i18n.t('account:signIn.google'),
      })
      const email = screen.getByRole('textbox', {
        name: i18n.t('account:signIn.emailLabel'),
      })
      const send = screen.getByRole('button', {
        name: i18n.t('account:signIn.sendCode'),
      })
      const skip = screen.getByRole('button', {
        name: i18n.t('onboarding-account:skip'),
      })
      expectNoHorizontalOverflow(document.body)
      // The sign-in row's controls line up with the step's own buttons.
      expectSameHeight([google, email, send, skip])
      expectSameHeight(
        Array.from(document.querySelectorAll('.ob-account-benefit'))
      )
      const before = skip.getBoundingClientRect().top

      fireEvent.change(email, { target: { value: 'ada@example.com' } })
      await act(async () => {
        fireEvent.click(send)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(screen.getByRole('alert')).not.toBeEmptyDOMElement()
      await settle(document.body)

      // The message line is reserved: an error never moves the page.
      expectNoHorizontalOverflow(document.body)
      expect(skip.getBoundingClientRect().top).toBeCloseTo(before, 0)
    }
  )

  it.each([1024, 1280])(
    'keeps a long signed-in account inside its card at %i px',
    async (width) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(XL_FONT_SIZE)
      await i18n.changeLanguage('en')
      await renderStep({ signedIn: true, user })

      const ready = await screen.findByTestId('onboarding-account-ready')
      await settle(document.body)
      expectNoHorizontalOverflow(ready)
      expectNoHorizontalOverflow(document.body)
    }
  )
})
