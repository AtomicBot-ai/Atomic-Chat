import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'

import { ConnectedTools } from '../ConnectedTools'

describe('Connections, connected tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ serverStatus: 'running' })
    useServerSetup.setState({
      configuredAgents: [],
      endpointConfigured: false,
      guide: null,
      guideActive: false,
    })
  })

  it('says when nothing is connected, and adds a connection through the guide', () => {
    render(<ConnectedTools />)

    expect(screen.getByText('api:connected.empty')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'api:connected.add' }))
    expect(useServerSetup.getState().guide).toEqual({ path: 'choose' })
    expect(navigate).toHaveBeenCalledWith({ to: '/api/' })
  })

  it('lists the tools set up here and the custom application, ready while the server runs', () => {
    useServerSetup.setState({
      configuredAgents: [{ id: 'codex', at: 1 }],
      endpointConfigured: true,
    })
    render(<ConnectedTools />)

    expect(screen.getByText('Codex CLI')).toBeInTheDocument()
    expect(screen.getByText('api:connected.endpoint')).toBeInTheDocument()
    expect(screen.getAllByText('api:connected.ready')).toHaveLength(2)
  })

  it('only forgets a tool: its own settings are not touched', () => {
    useServerSetup.setState({
      configuredAgents: [{ id: 'codex', at: 1 }],
      endpointConfigured: true,
    })
    useAppState.setState({ serverStatus: 'stopped' })
    render(<ConnectedTools />)
    expect(screen.getAllByText('api:connected.serverStopped')).toHaveLength(2)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:connected.forget:{"name":"Codex CLI"}',
      })
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:connected.forget:{"name":"api:connected.endpoint"}',
      })
    )

    expect(useServerSetup.getState()).toMatchObject({
      configuredAgents: [],
      endpointConfigured: false,
    })
    expect(screen.getByText('api:connected.empty')).toBeInTheDocument()
  })
})
