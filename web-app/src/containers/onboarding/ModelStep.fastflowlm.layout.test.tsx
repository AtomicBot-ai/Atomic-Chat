import '@/test/telemetry-ready'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { expect, it, vi } from 'vitest'
import { atomicModelCatalogBaseline } from '@janhq/core'
import i18n from '@/i18n/setup'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { fastFlowLmModels } from '@/services/fastflowlm/catalog'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { ModelStep } from './steps/ModelStep'
import './onboarding.css'

const options = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('./useModelOptions', () => ({ useModelOptions: () => options.current }))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
  isServiceHubInitialized: () => true,
}))
vi.mock('@/lib/onboarding/downloads', () => ({
  importCandidatesInBackground: vi.fn(),
  providerForCandidate: vi.fn(),
  startGgufCatalogDownload: vi.fn(),
  startMlxCatalogDownload: vi.fn(),
}))
vi.mock('@/services/fastflowlm/core', () => ({ checkFastFlowLmModel: vi.fn() }))
vi.mock('@/services/fastflowlm/install', () => ({ installFastFlowLm: vi.fn() }))
vi.mock('@/containers/fastflowlm/FastFlowLmEnginePanel', () => ({
  FastFlowLmEnginePanel: () => <div>FastFlowLM</div>,
}))
vi.mock('@/containers/fastflowlm/FastFlowLmPreparation', () => ({
  FastFlowLmPreparation: () => <div>AMD XDNA2</div>,
}))

for (const [width, font, theme] of [
  [1024, '20px', 'dark'],
  [1280, '13px', 'light'],
] as const) {
  it(`keeps ordinary onboarding and Continue visible without the FLM shelf at ${width}px and ${font}`, async () => {
    await page.viewport(width, 800)
    setTheme(theme)
    setFontSize(font)
    await i18n.changeLanguage('ru')
    useOnboardingStore.getState().reset()
    const staleFlm = fastFlowLmModels(atomicModelCatalogBaseline()).map(
      (model) => ({ title: model.name, provider: 'fastflowlm' })
    )
    const rows = ['LFM2.5 1.2B', 'Qwen3.8 27B', 'Muse Glimmer 30B'].map(
      (title, position) => ({
        kind: 'download',
        key: `download:${position}`,
        title,
        detail: 'Local chat and coding',
        iconSrc: null,
        provider: 'llamacpp-upstream',
        matchIds: [String(position)],
        catalog: { model_name: title },
        variant: { model_id: String(position) },
        isMlx: false,
        taskId: String(position),
        sizeLabel: '18.5 GB',
        sizeBytes: 18.5 * 1024 ** 3,
        fit: 'ok',
        bestFit: position === 0,
        source: 'recommended',
        position,
      })
    )
    options.current = {
      ready: true,
      catalogLoading: false,
      fastflowlm: staleFlm,
      recommended: rows,
      huggingFace: [],
      onDevice: [],
      library: [],
      detected: [],
      device: { name: 'AMD Ryzen AI 9 HX 370', memoryGb: 32, freeGb: 128 },
      tier: 'discrete_16',
      tierReady: true,
      tierFinal: true,
      tierResolvedMs: 0,
      profile: null,
    }
    const { container } = render(
      withTranslations(
        <div className="ob-shell">
          <main className="ob-main">
            <div className="ob-content ob-model-step">
              <ModelStep next={vi.fn()} handOff={vi.fn()} />
            </div>
          </main>
        </div>
      )
    )
    await act(async () => settle(container))
    const catalog = container.querySelector<HTMLElement>('.ob-model-catalog')!
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Движок/ })
    ).not.toBeInTheDocument()
    const action = container.querySelector<HTMLButtonElement>(
      '.ob-model-actionbar button'
    )!
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.queryByText('Все модели FastFlowLM')).not.toBeInTheDocument()
    expectNoHorizontalOverflow(container.querySelector('.ob-main')!)
    expectNoHorizontalOverflow(catalog)
    expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(800)
    fireEvent.scroll(catalog, { target: { scrollTop: catalog.scrollHeight } })
    expect(action.getBoundingClientRect().bottom).toBeLessThanOrEqual(800)
  })
}
