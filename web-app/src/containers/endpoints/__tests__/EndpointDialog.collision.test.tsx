import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

import { EndpointDialog } from '@/containers/endpoints/EndpointDialog'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle } from '@/lib/utils'

const endpoint = {
  provider: 'my-server',
  active: true,
  base_url: 'http://127.0.0.1:9/v1',
  api_key: '',
  settings: [],
  models: [{ id: 'qwen' }, { id: 'only-remote' }],
} as unknown as ProviderObject

const renderDialog = () =>
  render(
    <EndpointDialog
      open
      onOpenChange={vi.fn()}
      provider={endpoint}
      takenNames={[]}
      onSave={vi.fn()}
    />
  )

describe('EndpointDialog: a model id a local engine also lists (AC-03)', () => {
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

  it('names the provider the server page selected for it', () => {
    useLocalApiServer.setState({
      lastServerModels: [{ model: 'qwen', provider: 'llamacpp-upstream' }],
    })
    renderDialog()

    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('endpoints:dialog.localModelCollision')
    expect(notice).toHaveTextContent('"model":"qwen"')
    expect(notice).toHaveTextContent(
      `"provider":"${getProviderTitle('llamacpp-upstream')}"`
    )
    expect(notice).not.toHaveTextContent('only-remote')
  })

  it('says the endpoint gets it while nothing is selected for it', () => {
    renderDialog()

    expect(screen.getByRole('status')).toHaveTextContent(
      'endpoints:dialog.localModelCollisionUnselected {"model":"qwen"}'
    )
  })

  it('shows nothing when no local engine lists the endpoint’s models', () => {
    useModelProvider.setState({
      providers: [endpoint as unknown as ModelProvider],
    })
    renderDialog()

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
