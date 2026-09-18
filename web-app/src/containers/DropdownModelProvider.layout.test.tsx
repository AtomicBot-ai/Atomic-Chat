import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'

import DropdownModelProvider from './DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useAppState } from '@/hooks/useAppState'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { TranslationContext } from '@/i18n/context'
import i18n from '@/i18n/setup'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'
import { seedServiceHub } from '@/test/service-hub'
import { qualifiedModelDisplayName } from '@/lib/model-display-name'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameWidth,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

vi.mock('@/stores/provider-registry-store', () => ({
  isKnownProvider: () => false,
  useProviderRegistryStore: {
    getState: () => ({ hasInitialized: true, providers: [] }),
  },
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
// These other picker views require backend/catalog services, not used by
// the main panel. Keep the actual Radix portal, status, avatar and slider.
vi.mock('./ModelPickerDownloads', () => ({
  HuggingFaceAction: () => null,
  ModelPickerEmptyState: () => null,
}))
vi.mock('./dialogs/AddCloudProviderDialog', () => ({
  AddCloudProviderDialog: () => null,
}))

const model = {
  id: 'AtomicChat/Qwen3.6-27B-Extra-Long-Model-Name-19.7GB-100-percent',
  displayName: 'Qwen 3.6 27B with a very long model display name 19.7 GB',
  capabilities: ['completion'],
  reasoning: { supportsThinking: true },
} as Model
const provider = {
  provider: 'mlx',
  active: true,
  models: [model],
  settings: [],
} as unknown as ModelProvider

async function openPanel(translatedLabels = false) {
  // A 256 px sidebar remains open, with the composer at the bottom right
  // of the available chat column, like the desktop app.
  render(
    withTranslations(
      <div className="flex h-screen">
        <aside className="w-64 shrink-0" aria-label="Sidebar" />
        <main className="flex min-w-0 flex-1 items-end justify-end p-4">
          <TranslationContext.Provider
            value={{
              i18n,
              t: (key, options) => {
                if (translatedLabels && key === 'common:reasoningEffort.faster')
                  return 'Schnellere Antworten'
                if (
                  translatedLabels &&
                  key === 'common:reasoningEffort.smarter'
                )
                  return 'Gründlicher nachdenken'
                return i18n.t(key, options)
              },
            }}
          >
            <DropdownModelProvider />
          </TranslationContext.Provider>
        </main>
      </div>
    )
  )
  fireEvent.click(
    document.querySelector('[data-test-id="model-picker-trigger"]')!
  )
  const panel = await screen.findByRole('dialog')
  await act(async () => {
    await settle()
  })
  return panel
}

function checkContents(panel: HTMLElement) {
  expectNoHorizontalOverflow(panel)
  const row = screen.getByRole('button', { name: 'Change model' })
  const title = row.querySelector<HTMLElement>('.truncate')!
  expect(title.getAttribute('title')).toBe(qualifiedModelDisplayName(model))
  expectOneLine(title)
  for (const label of ['Faster', 'Smarter'])
    expectOneLine(screen.getByText(label))
  const effort = panel.querySelector<HTMLElement>(
    '[data-test-id="reasoning-effort-panel"]'
  )!
  const track = screen
    .getByRole('slider')
    .closest<HTMLElement>('[data-orientation="horizontal"].touch-none')!
  expectSameWidth([effort, track])
  // Consistent 16 px horizontal insets for explanatory text and the scale.
  const bounds = panel.getBoundingClientRect()
  for (const element of [effort]) {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    expect(box.left + parseFloat(style.paddingLeft) - bounds.left).toBeCloseTo(
      13,
      0
    )
    expect(
      bounds.right - box.right + parseFloat(style.paddingRight)
    ).toBeCloseTo(13, 0)
  }
  expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Off')
}

describe('composer model settings popover geometry', () => {
  beforeEach(async () => {
    localStorage.clear()
    await useGeneralSetting.persist.rehydrate()
    seedServiceHub({})
    useModelProvider.setState({
      providers: [provider],
      selectedProvider: 'mlx',
      selectedModel: model,
    })
    useGeneralSetting.setState({
      disableReasoning: true,
      reasoningBudget: 'medium',
    })
    useAppState.setState({ activeModels: [], loadingModel: false })
    useModelLoad.setState({
      modelLoadError: undefined,
      modelLoadErrorModelId: undefined,
    })
    useLeftPanel.setState({ open: true })
    useRunSettingsPanel.setState({ isOpen: false })
  })

  for (const width of [1024, 1280]) {
    for (const font of ['16px', '18px', '20px']) {
      for (const theme of ['light', 'dark'] as const) {
        it(`${width}px / ${font} / ${theme}: readable, full-width scale without overflow`, async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(theme)
          const panel = await openPanel()
          const box = panel.getBoundingClientRect()
          expect(box.width).toBeGreaterThanOrEqual(351)
          expect(box.width).toBeLessThanOrEqual(352)
          expect(box.left).toBeGreaterThanOrEqual(16)
          expect(box.right).toBeLessThanOrEqual(width - 16)
          checkContents(panel)
          expectNoHorizontalOverflow(document.body)
        })
      }
    }
  }

  it('keeps translated endpoints on one line and the shell stable through load states', async () => {
    await page.viewport(1024, 800)
    setFontSize('20px')
    const panel = await openPanel(true)
    const initialWidth = panel.getBoundingClientRect().width
    for (const label of ['Schnellere Antworten', 'Gründlicher nachdenken']) {
      expectOneLine(screen.getByText(label))
    }
    for (const app of [
      {
        loadingModel: true,
        loadingModelId: model.id,
        loadingModelKind: 'start' as const,
        activeModels: [],
      },
      { loadingModel: false, activeModels: [model.id] },
    ]) {
      await act(async () => {
        useAppState.setState(app)
      })
      await act(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      expect(panel.getBoundingClientRect().width).toBe(initialWidth)
      expectNoHorizontalOverflow(panel)
    }
  })

  it('owns vertical scrolling in a short viewport', async () => {
    await page.viewport(1024, 200)
    setFontSize('20px')
    const panel = await openPanel()
    const box = panel.getBoundingClientRect()
    expect(box.top).toBeGreaterThanOrEqual(16)
    expect(box.bottom).toBeLessThanOrEqual(184)
    expect(getComputedStyle(panel).overflowY).toBe('auto')
    expect(panel.scrollHeight).toBeGreaterThan(panel.clientHeight)
    expectNoHorizontalOverflow(panel)
  })

  it('bounds the shell to a narrow viewport at Extra Large', async () => {
    await page.viewport(390, 600)
    setFontSize('20px')
    const panel = await openPanel()
    const box = panel.getBoundingClientRect()
    expect(box.width).toBeLessThanOrEqual(358)
    expect(box.left).toBeGreaterThanOrEqual(16)
    expect(box.right).toBeLessThanOrEqual(374)
    checkContents(panel)
  })
})
