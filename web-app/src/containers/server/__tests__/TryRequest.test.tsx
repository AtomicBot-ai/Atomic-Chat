import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendTest } = vi.hoisted(() => ({ sendTest: vi.fn() }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@/utils/localApiServerControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/localApiServerControl')>()),
  sendTestChatCompletion: sendTest,
}))

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'

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
    useModelProvider.setState({ providers: [] })
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

  const clickSend = async () => {
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'api:connections.sendTest' })
      )
    })
  }

  it('sends the chat completion it shows, for that model, and names who answered', async () => {
    useLocalApiServer.setState({ apiKey: 'secret' })
    sendTest.mockResolvedValue({ ok: true, latencyMs: 12, model: 'gemma-4' })
    render(<TryRequest />)
    expect(screen.getByText(/"model":"gemma-4"/)).toBeInTheDocument()

    await clickSend()

    expect(sendTest.mock.calls).toEqual([[BASE, 'secret', 'gemma-4']])
    expect(screen.getByRole('status')).toHaveTextContent(
      'api:connections.testOk:{"ms":12,"model":"gemma-4"}'
    )
  })

  it('skips the embedding model project indexing loaded beside the chat model', async () => {
    useAppState.setState({
      activeModels: [EMBEDDING_MODEL_ID, 'nomic-embed', 'gemma-4'],
    })
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          settings: [],
          models: [{ id: 'nomic-embed', embedding: true }, { id: 'gemma-4' }],
        } as unknown as ModelProvider,
      ],
    })
    sendTest.mockResolvedValue({ ok: true, latencyMs: 9, model: 'gemma-4' })
    render(<TryRequest />)
    expect(screen.getByText(/"model":"gemma-4"/)).toBeInTheDocument()

    await clickSend()

    expect(sendTest.mock.calls).toEqual([[BASE, '', 'gemma-4']])
  })

  it('names no model when only an embedding model is loaded', () => {
    useAppState.setState({ activeModels: [EMBEDDING_MODEL_ID] })
    render(<TryRequest />)

    expect(
      screen.getByText(new RegExp(`"model":"${MODEL_PLACEHOLDER}"`))
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'api:connections.sendTest' })
    ).toBeDisabled()
  })

  it('says there is no model to send it to, instead of sending a placeholder', () => {
    useAppState.setState({ activeModels: [] })
    render(<TryRequest />)

    expect(
      screen.getByRole('button', { name: 'api:connections.sendTest' })
    ).toBeDisabled()
    expect(
      screen.getByText('api:connections.testNeedsModel')
    ).toBeInTheDocument()
  })

  it('says no model is loaded when the server has none to answer with', async () => {
    useAppState.setState({ activeModels: [] })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: { model: 'qwen', provider: 'mlx' },
    })
    sendTest.mockResolvedValue({
      ok: false,
      latencyMs: 2,
      model: 'qwen',
      httpStatus: 503,
      message: 'HTTP 503: No models are available',
    })
    render(<TryRequest />)

    await clickSend()

    expect(sendTest.mock.calls).toEqual([[BASE, '', 'qwen']])
    expect(screen.getByRole('alert')).toHaveTextContent(
      'api:connections.testNoModel'
    )
  })

  it('says which model the server is not running', async () => {
    sendTest.mockResolvedValue({
      ok: false,
      latencyMs: 2,
      model: 'gemma-4',
      httpStatus: 404,
      message: 'HTTP 404: model_not_found',
    })
    render(<TryRequest />)

    await clickSend()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'api:connections.testModelNotServed:{"model":"gemma-4"}'
    )
  })

  it('shows a 503 from elsewhere as the server put it while a model is loaded', async () => {
    sendTest.mockResolvedValue({
      ok: false,
      latencyMs: 2,
      model: 'gemma-4',
      httpStatus: 503,
      message: 'HTTP 503: upstream overloaded',
    })
    render(<TryRequest />)

    await clickSend()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'api:connections.testFailed:{"message":"HTTP 503: upstream overloaded"}'
    )
  })

  it('says when the server turned the key down', async () => {
    sendTest.mockResolvedValue({
      ok: false,
      latencyMs: 3,
      model: 'gemma-4',
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
