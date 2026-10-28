import '@/test/telemetry-ready'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import i18n from '@/i18n/setup'
import { useOnboardingStore } from '@/stores/onboarding-store'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { WaitStep } from './steps/WaitStep'
import './onboarding.css'

vi.mock('@/stores/email-reminder-store', () => ({
  useEmailReminderStore: (selector: (state: { reminder: null }) => unknown) =>
    selector({ reminder: null }),
  requestEmailReminder: vi.fn().mockRejectedValue(new Error('offline')),
}))

describe.each(['light', 'dark'] as const)('email reminder in %s', (theme) => {
  beforeEach(() => {
    useModelProvider.setState({ providers: [] })
    useOnboardingStore.getState().reset()
    useOnboardingStore.getState().choose({
      source: 'download',
      provider: 'llamacpp-upstream',
      modelId: 'qwen',
      title: 'Qwen3.5 30B A3B Instruct 2507',
      matchIds: ['qwen'],
    })
  })

  it.each(
    ['en', 'ru'].flatMap((language) =>
      [1024, 1280].flatMap((width) =>
        ['13px', '20px'].map((font) => ({ language, width, font }))
      )
    )
  )(
    'fits at $width px with $font text in $language, including errors',
    async ({ language, width, font }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(font)
      await i18n.changeLanguage(language)
      render(
        withTranslations(
          <div className="ob-shell">
            <main className="ob-main">
              <div className="ob-content">
                <WaitStep next={vi.fn()} goTo={vi.fn()} handOff={vi.fn()} />
              </div>
            </main>
          </div>
        )
      )
      const input = screen.getByRole('textbox')
      const form = input.closest('form')!
      await settle(document.body)
      const button = screen.getByRole('button', {
        name: i18n.t('onboarding-wait:email.submit'),
      })
      const before = button.getBoundingClientRect()
      expectNoHorizontalOverflow(form)
      expectNoHorizontalOverflow(document.body)
      expect(input.getBoundingClientRect().width).toBeGreaterThan(160)
      fireEvent.change(input, {
        target: { value: 'long.valid.address.for.a.reminder@example.com' },
      })
      fireEvent.submit(form)
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toContain(
          i18n.t('onboarding-wait:email.error')
        )
      )
      await settle(document.body)
      expectNoHorizontalOverflow(form)
      expectNoHorizontalOverflow(document.body)
      expect(button.getBoundingClientRect().width).toBeCloseTo(before.width, 0)
      expect(button.getBoundingClientRect().top).toBeCloseTo(before.top, 0)
    }
  )
})
