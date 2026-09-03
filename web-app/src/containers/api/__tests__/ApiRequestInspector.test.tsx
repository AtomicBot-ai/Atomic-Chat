import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiRequestEntry } from '@/types/apiServerLog'

import { ApiRequestInspector } from '../ApiRequestInspector'

const { contextLength } = vi.hoisted(() => ({
  contextLength: { value: undefined as number | undefined },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: (selector: (s: { apiPrefix: string }) => unknown) =>
    selector({ apiPrefix: '/v1' }),
}))

vi.mock('@/utils/apiServerCapacity', () => ({
  getModelContextLength: () => contextLength.value,
}))

function request(overrides: Partial<ApiRequestEntry> = {}): ApiRequestEntry {
  return {
    kind: 'request',
    id: 'apireq_45429c154904',
    seq: 1,
    startedAt: 1_700_000_000_000,
    status: 'completed',
    method: 'POST',
    endpoint: 'chat/completions',
    model: 'gemma-4-E4B-it-GGUF',
    stream: true,
    durationMs: 3500,
    ttftMs: 755,
    promptTokens: 28,
    completionTokens: 150,
    totalTokens: 178,
    finishReason: 'length',
    promptPreview: 'What is Unsloth?',
    replyPreview: 'Hello! Red, blue, and green.',
    ...overrides,
  }
}

describe('ApiRequestInspector', () => {
  beforeEach(() => {
    contextLength.value = 4096
  })

  it('renders the full stat grid for a completed request', () => {
    render(<ApiRequestInspector entry={request()} hasSelection />)
    expect(screen.getByText('POST /v1/chat/completions')).toBeInTheDocument()
    expect(screen.getByText('apireq_45429c154904')).toBeInTheDocument()
    expect(screen.getByText('28')).toBeInTheDocument()
    expect(screen.getByText('150')).toBeInTheDocument()
    expect(screen.getByText('178')).toBeInTheDocument()
    expect(screen.getByText('4 096')).toBeInTheDocument()
    expect(screen.getByText('755 ms')).toBeInTheDocument()
    expect(screen.getByText('3.5 s')).toBeInTheDocument()
    expect(screen.getByText('length')).toBeInTheDocument()
    expect(screen.getByText('What is Unsloth?')).toBeInTheDocument()
    expect(screen.getByText('Hello! Red, blue, and green.')).toBeInTheDocument()
  })

  it('derives generation duration and speeds from the raw timings', () => {
    render(<ApiRequestInspector entry={request()} hasSelection />)
    // 3500 - 755 = 2745 ms of generation, 150 tokens => 54.6 tok/s
    expect(screen.getByText('2.7 s')).toBeInTheDocument()
    expect(screen.getByText('54.6 tok/s')).toBeInTheDocument()
    // 28 prompt tokens over the 755 ms wait => 37.1 tok/s
    expect(screen.getByText('37.1 tok/s')).toBeInTheDocument()
  })

  it('prefers upstream-reported rates over derived ones', () => {
    render(
      <ApiRequestInspector
        entry={request({ predictedPerSecond: 99.9, promptPerSecond: 11.1 })}
        hasSelection
      />
    )
    expect(screen.getByText('99.9 tok/s')).toBeInTheDocument()
    expect(screen.getByText('11.1 tok/s')).toBeInTheDocument()
  })

  it('renders a dash for every unknown value', () => {
    render(
      <ApiRequestInspector
        entry={request({
          durationMs: undefined,
          ttftMs: undefined,
          promptTokens: undefined,
          completionTokens: undefined,
          totalTokens: undefined,
          finishReason: undefined,
        })}
        hasSelection
      />
    )
    expect(screen.getAllByText('–').length).toBeGreaterThanOrEqual(6)
  })

  it('marks token counts that were only estimated', () => {
    render(
      <ApiRequestInspector
        entry={request({ completionTokens: 150, tokensEstimated: true })}
        hasSelection
      />
    )
    expect(screen.getByText('~150')).toBeInTheDocument()
  })

  it('falls back to a dash when the context length is unknown', () => {
    contextLength.value = undefined
    render(<ApiRequestInspector entry={request()} hasSelection />)
    expect(screen.getByText('api:detail.context')).toBeInTheDocument()
    expect(screen.getAllByText('–').length).toBeGreaterThanOrEqual(1)
  })

  it('previews a reasoning-only reply', () => {
    // Reasoning models leave `content` null and stream `reasoning_content`;
    // the proxy previews that rather than showing nothing.
    render(
      <ApiRequestInspector
        entry={request({ replyPreview: 'Thinking Process:', ttftMs: 120 })}
        hasSelection
      />
    )
    expect(screen.getByText('Thinking Process:')).toBeInTheDocument()
    expect(screen.getByText('120 ms')).toBeInTheDocument()
  })

  it('surfaces the error kind and HTTP status for a failed request', () => {
    render(
      <ApiRequestInspector
        entry={request({
          status: 'error',
          errorKind: 'upstream_status',
          httpStatus: 500,
        })}
        hasSelection
      />
    )
    expect(screen.getByText(/upstream_status · HTTP 500/)).toBeInTheDocument()
  })

  it('falls back to placeholders when previews are missing', () => {
    render(
      <ApiRequestInspector
        entry={request({ promptPreview: undefined, replyPreview: undefined })}
        hasSelection
      />
    )
    expect(screen.getByText('api:detail.noPrompt')).toBeInTheDocument()
    expect(screen.getByText('api:detail.noReply')).toBeInTheDocument()
  })

  it('prompts for a selection, and reports an evicted one', () => {
    const { rerender } = render(
      <ApiRequestInspector entry={undefined} hasSelection={false} />
    )
    expect(screen.getByText('api:detail.selectPrompt')).toBeInTheDocument()
    rerender(<ApiRequestInspector entry={undefined} hasSelection />)
    expect(screen.getByText('api:detail.gone')).toBeInTheDocument()
  })
})
