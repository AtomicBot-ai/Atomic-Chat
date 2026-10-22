import { render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import i18n from '@/i18n/setup'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'
import {
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

import { OnboardingHandoffPanel } from './OnboardingHandoffPanel'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
  isServiceHubInitialized: () => true,
  initializeServiceHubStore: vi.fn(),
}))

const GB = 1024 ** 3

/**
 * A text button's label lays out on one line. `expectOneLine` also bounds the
 * element's height, which a padded button exceeds on one line too.
 */
function expectLabelOnOneLine(button: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(button)
  const tops = new Set(
    [...range.getClientRects()]
      .filter((line) => line.width > 0 && line.height > 0)
      .map((line) => Math.round(line.top))
  )
  expect(tops.size, `"${button.textContent}" wraps`).toBe(1)
}

// A long catalog title and every part of the readout at once: bytes, time
// left and the queue behind it.
const chat: OnboardingJob = {
  key: 'chat',
  kind: 'chat',
  title: 'Qwen3.5 30B A3B Instruct 2507',
  taskId: 'Qwen3.5-30B-A3B-Instruct-2507-Q4_K_M',
  totalBytes: 18.6 * GB,
  phase: 'running',
}
const queued = (key: string): OnboardingJob => ({
  key,
  kind: 'image',
  title: key,
  taskId: `diffusion-model-${key}_q4`,
  phase: 'queued',
})

describe.each(['light', 'dark'] as const)(
  'handoff panel in the %s theme',
  (theme) => {
    beforeEach(() => {
      useOnboardingStore.getState().reset()
      const run = useOnboardingStore.getState()
      run.begin('full', 'model')
      for (const job of [chat, queued('z-image'), queued('ltx-2')]) {
        run.enqueue(job)
      }
      run.handOff('chat')
      useModelProvider.setState({ providers: [] } as never)
      useDownloadStore.setState({
        downloads: {
          [chat.taskId]: {
            id: chat.taskId,
            name: chat.taskId,
            progress: 0.42,
            current: 0.42 * 18.6 * GB,
            total: 18.6 * GB,
            speed: {
              bytesPerSecond: 11.4 * 1024 ** 2,
              atBytes: 0.42 * 18.6 * GB,
              atTime: Date.now(),
            },
          },
        },
        pausedDownloads: new Set(),
      } as never)
    })

    it.each(['en', 'ru'])(
      'keeps every line on one line at Extra Large in %s',
      async (language) => {
        await page.viewport(1024, 768)
        setTheme(theme)
        setFontSize(XL_FONT_SIZE)
        await i18n.changeLanguage(language)
        render(withTranslations(<OnboardingHandoffPanel />))

        const panel = screen.getByTestId('onboarding-handoff')
        await settle(panel)

        const strip = within(panel).getByRole('region', {
          name: i18n.t('onboarding:download.label'),
        })
        expectOneLine(within(strip).getByText(chat.title))
        const readout = strip.querySelector<HTMLElement>(
          '.ob-download-row > div > span'
        )!
        const queuedNote = i18n
          .t('onboarding:download.withQueued', { readout: '', count: 2 })
          .replace(/^\s*·\s*/, '')
        expect(readout.textContent).toContain(queuedNote)
        expectOneLine(readout)
        for (const name of [
          i18n.t('onboarding-handoff:panel.backToSetup'),
          i18n.t('onboarding-handoff:panel.dismiss'),
        ]) {
          expectLabelOnOneLine(within(panel).getByRole('button', { name }))
        }
        expectNoHorizontalOverflow(panel)
        expectNoHorizontalOverflow(document.body)

        const box = panel.getBoundingClientRect()
        expect(box.right).toBeLessThanOrEqual(window.innerWidth)
        expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
        // The panel lives in the app and wears its theme.
        const probe = document.createElement('div')
        probe.style.background = 'var(--background)'
        document.body.append(probe)
        expect(getComputedStyle(panel).backgroundColor).toBe(
          theme === 'dark'
            ? 'rgb(23, 33, 27)'
            : getComputedStyle(probe).backgroundColor
        )
        probe.remove()
      }
    )
  }
)
