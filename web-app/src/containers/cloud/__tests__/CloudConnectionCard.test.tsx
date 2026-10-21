import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CloudConnectionCard } from '../CloudConnectionCard'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))
vi.mock('@/containers/dialogs/DeleteProvider', () => ({
  default: () => <span />,
}))

const GENERIC = 'cloud:connection.description'

const provider = (patch: Partial<ProviderObject>): ProviderObject =>
  ({
    provider: 'openai',
    active: true,
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    models: [],
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        controller_type: 'input',
        controller_props: { value: '' },
      },
    ],
    ...patch,
  }) as unknown as ProviderObject

function renderCard(selected: ProviderObject, hideProviderSelect = true) {
  render(
    <CloudConnectionCard
      hideProviderSelect={hideProviderSelect}
      providers={[selected]}
      selected={selected}
      onSelect={() => {}}
      onAddCustom={() => {}}
      onDeleted={() => {}}
      updateProvider={() => {}}
      serviceHub={{ providers: () => ({}) } as never}
    />
  )
}

describe('CloudConnectionCard header', () => {
  it("links a catalogue provider's own model list under its name, not the generic line", () => {
    renderCard(
      provider({
        explore_models_url: 'https://platform.openai.com/docs/models',
      })
    )

    expect(
      screen.getByRole('heading', { level: 2, name: 'OpenAI' })
    ).toBeInTheDocument()
    const link = screen.getByRole('link', {
      name: 'providers:addModel.exploreModels {"provider":"OpenAI"}',
    })
    expect(link).toHaveAttribute(
      'href',
      'https://platform.openai.com/docs/models'
    )
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument()
  })

  it('drops the subtitle for a provider the catalogue says nothing more about', () => {
    renderCard(
      provider({
        provider: 'chatgpt',
        base_url: 'https://chatgpt.com/backend-api/codex',
        settings: [],
      })
    )

    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'ChatGPT subscription (Codex)',
      })
    ).toBeInTheDocument()
    expect(screen.queryByText(GENERIC)).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps the generic line where the card is the provider picker', () => {
    renderCard(
      provider({
        explore_models_url: 'https://platform.openai.com/docs/models',
      }),
      false
    )

    expect(
      screen.getByRole('heading', { level: 2, name: 'cloud:connection.title' })
    ).toBeInTheDocument()
    expect(screen.getByText(GENERIC)).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /exploreModels/ })
    ).not.toBeInTheDocument()
  })
})
