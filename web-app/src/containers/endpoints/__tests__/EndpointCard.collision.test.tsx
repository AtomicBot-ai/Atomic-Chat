import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

import { EndpointCard } from '@/containers/endpoints/EndpointCard'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'

const endpoint = {
  provider: 'my-server',
  active: true,
  base_url: 'http://127.0.0.1:9/v1',
  api_key: '',
  settings: [],
  models: [{ id: 'qwen' }],
} as unknown as ProviderObject

const renderCard = (expanded: boolean) =>
  render(
    <EndpointCard
      provider={endpoint}
      expanded={expanded}
      onToggleExpanded={vi.fn()}
      onConnectMedia={vi.fn()}
      onPing={vi.fn()}
      onConfigure={vi.fn()}
    >
      <p>models</p>
    </EndpointCard>
  )

describe('EndpointCard: a fetched model id a local engine also lists (AC-03)', () => {
  beforeEach(() => {
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [{ id: 'qwen' }],
        } as unknown as ModelProvider,
        endpoint as unknown as ModelProvider,
      ],
    })
    useLocalApiServer.setState({
      lastServerModels: [],
      defaultModelLocalApiServer: null,
    })
  })

  it('says where the server sends it with the models, without reopening the dialog', () => {
    renderCard(true)

    expect(
      screen.getByText(
        'endpoints:dialog.localModelCollisionUnselected {"model":"qwen"}'
      )
    ).toBeInTheDocument()
  })

  it('stays out of a collapsed card', () => {
    renderCard(false)

    expect(screen.queryByText(/localModelCollision/)).not.toBeInTheDocument()
  })
})
