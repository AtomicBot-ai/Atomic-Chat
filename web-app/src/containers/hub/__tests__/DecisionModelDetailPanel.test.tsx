import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

vi.mock('@/containers/hub/HubReadme', () => ({
  HubReadme: ({ url }: { url: string }) => (
    <div data-testid="readme">{url}</div>
  ),
}))

vi.mock('@/containers/DecisionModelCard', () => ({
  default: ({
    model,
    onOpen,
  }: {
    model: DecisionCatalogModel
    onOpen?: () => void
  }) => (
    <button type="button" onClick={onOpen}>
      {`actions for ${model.id}`}
    </button>
  ),
}))

import {
  decisionDiskBytes,
  getBaselineDecisionCatalog,
} from '@/services/decision-catalog-registry'
import { useModelProvider } from '@/hooks/useModelProvider'
import { DecisionModelDetailPanel } from '../DecisionModelDetailPanel'

const model = getBaselineDecisionCatalog().models[0]
const byId = (id: string) =>
  getBaselineDecisionCatalog().models.find((m) => m.id === id)!

describe('DecisionModelDetailPanel', () => {
  it('asks for a pick when no model is open', () => {
    render(<DecisionModelDetailPanel model={null} />)

    expect(screen.getByText('hub:selectModel')).toBeVisible()
  })

  it('names the model, its size on disk and its details, and links the repo', () => {
    render(<DecisionModelDetailPanel model={model} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Laya Multilingual'
    )
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://huggingface.co/convaiinnovations/laya-multilingual'
    )
    const size = (decisionDiskBytes(model) / 1024 ** 3).toFixed(2)
    expect(
      screen.getByTestId('decision-download-laya-multilingual')
    ).toHaveTextContent(`settings:decision.diskSize {"size":"${size}"}`)
    expect(screen.getByText('settings:decision.multilingual')).toBeVisible()
    expect(screen.getByText('mmBERT-base')).toBeVisible()
    expect(screen.getByText('322M')).toBeVisible()
    expect(screen.getByText('apache-2.0')).toBeVisible()
  })

  it('reads the README at the revision the files come from', () => {
    render(<DecisionModelDetailPanel model={model} />)

    expect(screen.getByTestId('readme')).toHaveTextContent(
      `https://huggingface.co/convaiinnovations/laya-multilingual/resolve/${model.revision}/README.md`
    )
  })

  it('opens the llama.cpp TurboQuant page, where the model is started', async () => {
    render(<DecisionModelDetailPanel model={model} />)

    const actions = screen.getByRole('button', {
      name: 'actions for laya-multilingual',
    })
    expect(
      screen.getByTestId('decision-download-laya-multilingual')
    ).toContainElement(actions)
    await userEvent.click(actions)

    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'llamacpp' },
    })
  })

  it('opens a stock llama.cpp model on the llama.cpp page, with its quant, engine and license', async () => {
    navigate.mockClear()
    const clef = byId('openjev')
    render(<DecisionModelDetailPanel model={clef} />)

    expect(screen.getByTestId('decision-download-openjev')).toHaveTextContent(
      'Q4_K_M'
    )
    expect(
      screen.getByText('llama.cpp · hub:decisionReadsImages')
    ).toBeVisible()
    expect(
      screen.getByText('cc-by-nc-4.0 · hub:licenseNonCommercial')
    ).toBeVisible()
    await userEvent.click(
      screen.getByRole('button', { name: 'actions for openjev' })
    )
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { providerName: 'llamacpp-upstream' } })
    )
  })

  it('says which llama.cpp build a model needs when the configured one is older', () => {
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          settings: [
            {
              key: 'version_backend',
              controller_props: { value: 'b11344/macos-arm64' },
            },
          ],
        },
      ] as never,
    })
    render(<DecisionModelDetailPanel model={byId('clef')} />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'settings:decision.requiresEngineNotice {"engine":"llama.cpp","version":"b11418"}'
    )
    useModelProvider.setState({ providers: [] as never })
  })
})
