import { act, render, screen, waitFor } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import type { StoreApi, UseBoundStore } from 'zustand'

import { useInferenceStatus } from '@/hooks/useInferenceStatus'
import type { InferenceStatus } from '@/lib/inference-status'
import i18n from '@/i18n/setup'
import { ToasterProvider } from '@/providers/ToasterProvider'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameWidth,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
} from '@/test/layout'
import { modelLoadStages } from '@/test/model-load-stages'
import { ModelLoadSnackbar } from './ModelLoadSnackbar'

vi.mock('@/utils/switchModel', () => ({ cancelModelLoad: vi.fn() }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
}))

// Keep backend/provider discovery out of a geometry test; retain live updates
// for both the driver and the card rendered inside the real Sonner toaster.
vi.mock('@/hooks/useInferenceStatus', async () => {
  const { create } = await import('zustand')
  return {
    useInferenceStatus: create<InferenceStatus>(() => ({ phase: 'idle' })),
  }
})
const status = useInferenceStatus as UseBoundStore<StoreApi<InferenceStatus>>

const MODEL = 'org/' + 'VeryLongModelName'.repeat(20) + '-Q4_K_M.gguf'
const CANCEL = 'Ladevorgang abbrechen'

afterEach(() => {
  toast.dismiss()
  vi.restoreAllMocks()
})

describe.each(['light', 'dark'] as const)(
  'loading and loaded snackbar in %s theme',
  (theme) => {
    it.each(
      [1024, 1280].flatMap((width) =>
        ['16px', '18px', '20px'].map((fontSize) => ({ width, fontSize }))
      )
    )(
      'uses normal toast geometry at $width px / $fontSize',
      async ({ width, fontSize }) => {
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(fontSize)
        await i18n.changeLanguage('en')
        const translate = i18n.t
        vi.spyOn(i18n, 't').mockImplementation((key, options) =>
          key === 'common:modelLoad.cancel' ? CANCEL : translate(key, options)
        )
        act(() => status.setState({ phase: 'idle', modelId: MODEL }))
        render(
          <>
            <div className="flex w-full">
              <aside className="w-64 shrink-0">Sidebar</aside>
              <main className="min-w-0 flex-1">Chat</main>
            </div>
            <ToasterProvider />
            <ModelLoadSnackbar />
          </>
        )
        act(() => {
          status.setState({
            phase: 'starting',
            progress: { kind: 'loadingWeights', cachedFraction: 1 },
          })
        })
        const card = await screen.findByTestId('model-load-snackbar')
        expect(card.textContent).toBe(
          `Starting ModelLoading model into memory${CANCEL}`
        )
        expect(card.getBoundingClientRect().width).toBe(480)
        await settle(screen.getByText('Starting Model'))
        const initialHeight = card.getBoundingClientRect().height
        const cancel = screen.getByRole('button', {
          name: CANCEL,
          exact: true,
        })
        const initialCancelLeft = cancel.getBoundingClientRect().left
        for (const phase of ['starting', 'restarting'] as const) {
          for (const { progress } of modelLoadStages) {
            act(() => status.setState({ phase, progress }))
            expect(card.textContent).toBe(
              `Starting ModelLoading model into memory${CANCEL}`
            )
            expect(card.dataset.stage).toBe(progress.kind)
            expect(card.getBoundingClientRect().width).toBe(480)
            expect(card.getBoundingClientRect().height).toBe(initialHeight)
            expect(cancel.getBoundingClientRect().left).toBe(initialCancelLeft)
            expectOneLine(screen.getByText('Starting Model', { exact: true }))
            expectOneLine(
              screen.getByText('Loading model into memory', { exact: true })
            )
            expectNoHorizontalOverflow(card)
            expectNoHorizontalOverflow(document.body)
          }
        }
        act(() => status.setState({ phase: 'ready' }))
        await waitFor(() => expect(card.dataset.face).toBe('loaded'))
        await settle(card)

        // Sonner's actual production width, including its outer positioning box.
        const shell = card.closest<HTMLElement>('[data-sonner-toast]')!
        const toaster = card.closest<HTMLElement>('[data-sonner-toaster]')!
        expectSameWidth([card, shell, toaster])
        expectNoHorizontalOverflow(card)
        expectNoHorizontalOverflow(document.body)
        const title = screen.getByText('Model ready', { exact: true })
        const detail = screen.getByText('Loaded into memory', { exact: true })
        expectOneLine(title)
        expectOneLine(detail)
        expect(card.textContent).toBe('Model readyLoaded into memory')
        const icon = card.querySelector('svg')!
        expect(icon.getBoundingClientRect().width).toBeCloseTo(20, 1)
        expect(icon.getBoundingClientRect().height).toBeCloseTo(20, 1)
        expectVerticallyCentered(icon, title.parentElement!)
        expect(card.getBoundingClientRect().height).toBeLessThan(80)
        const dismiss = screen.getByRole('button', { name: 'Dismiss' })
        expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
          dismiss.getBoundingClientRect().left
        )
      }
    )
  }
)
