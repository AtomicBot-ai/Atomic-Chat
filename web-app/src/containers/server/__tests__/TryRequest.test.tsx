import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@/utils/localApiServerControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/localApiServerControl')>()),
  probeLocalApiServer: probe,
}))

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'

import {
  chatCompletionExample,
  MODEL_PLACEHOLDER,
  TryRequest,
} from '../TryRequest'

const BASE = 'http://127.0.0.1:1337/v1'

describe('chatCompletionExample', () => {
  it('writes a cURL call with the key header only when the server wants a key', () => {
    const open = chatCompletionExample('curl', BASE, 'qwen3.5-4b', false)
    expect(open).toContain(`curl ${BASE}/chat/completions \\`)
    expect(open).toContain('"model":"qwen3.5-4b"')
    expect(open).not.toContain('Authorization')

    const keyed = chatCompletionExample('curl', BASE, 'qwen3.5-4b', true)
    expect(keyed).toContain("-H 'Authorization: Bearer YOUR_API_KEY'")
  })

  it('keeps a quote in a model id from ending the shell string', () => {
    const example = chatCompletionExample('curl', BASE, "it's", false)
    expect(example).toContain(`"model":"it'\\''s"`)
  })

  it('writes the OpenAI Python client against the server', () => {
    const example = chatCompletionExample('python', `${BASE}/`, 'qwen', true)
    expect(example).toContain(
      `client = OpenAI(base_url="${BASE}", api_key="YOUR_API_KEY")`
    )
    expect(example).toContain('model="qwen",')
    expect(chatCompletionExample('python', BASE, 'qwen', false)).toContain(
      'api_key="not-needed"'
    )
  })
})

describe('Server → Connections, try a request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ serverStatus: 'running', activeModels: ['gemma-4'] })
    useLocalApiServer.setState({
      serverHost: '127.0.0.1',
      serverPort: 1337,
      apiPrefix: '/v1',
      apiKey: '',
      defaultModelLocalApiServer: null,
    })
  })

  it('shows the example for the loaded model and switches it to Python', async () => {
    const user = userEvent.setup()
    render(<TryRequest />)
    expect(screen.getByText(/"model":"gemma-4"/)).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'api:connections.language' })
    )
    await user.click(screen.getByRole('menuitemradio', { name: 'Python' }))
    expect(screen.getByText(/from openai import OpenAI/)).toBeInTheDocument()
  })

  it('names the model the next start loads, or a placeholder', () => {
    useAppState.setState({ activeModels: [] })
    const { unmount } = render(<TryRequest />)
    expect(
      screen.getByText(new RegExp(`"model":"${MODEL_PLACEHOLDER}"`))
    ).toBeInTheDocument()
    unmount()

    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'qwen', provider: 'mlx' },
    })
    render(<TryRequest />)
    expect(screen.getByText(/"model":"qwen"/)).toBeInTheDocument()
  })

  it('sends a real test request with the key and reports the answer', async () => {
    useLocalApiServer.setState({ apiKey: 'secret' })
    probe.mockResolvedValue({ ok: true, latencyMs: 12, modelCount: 2 })
    render(<TryRequest />)

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'api:connections.sendTest' })
      )
    })

    expect(probe).toHaveBeenCalledWith(BASE, 'secret')
    expect(screen.getByRole('status')).toHaveTextContent(
      'api:connections.testOk:{"ms":12,"count":2}'
    )
  })

  it('says when the server turned the key down', async () => {
    probe.mockResolvedValue({
      ok: false,
      latencyMs: 3,
      httpStatus: 401,
      message: 'HTTP 401: unauthorized',
    })
    render(<TryRequest />)

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'api:connections.sendTest' })
      )
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'api:connections.testUnauthorized:{"status":401}'
    )
  })

  it('offers no test while the server is stopped', () => {
    useAppState.setState({ serverStatus: 'stopped' })
    render(<TryRequest />)

    expect(
      screen.getByRole('button', { name: 'api:connections.sendTest' })
    ).toBeDisabled()
    expect(screen.getByText('api:connections.startToTest')).toBeInTheDocument()
  })
})
