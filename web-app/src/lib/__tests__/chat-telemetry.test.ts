import { beforeEach, describe, expect, it, vi } from 'vitest'

import posthog from 'posthog-js'
import {
  agentOutcome,
  agentResponseShape,
  attachmentTelemetry,
  beginChatTurn,
  captureChatRequest,
  captureChatResponse,
  codeBlockCount,
  contextTelemetry,
  currentChatTurn,
  responseShapeFromMessage,
  toolTelemetry,
} from '@/lib/chat-telemetry'
import type { Attachment } from '@/types/attachment'

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))

const captured = () => vi.mocked(posthog.capture).mock.calls

beforeEach(() => {
  vi.mocked(posthog.capture).mockClear()
})

const image = (name: string, size = 1024): Attachment => ({
  name,
  type: 'image',
  size,
  mimeType: 'image/png',
})

const doc = (name: string, fileType: string): Attachment => ({
  name,
  type: 'document',
  size: 2048,
  fileType,
  path: `/Users/alice/Documents/${name}`,
  parseMode: 'auto',
  injectionMode: 'embeddings',
  chunkCount: 12,
})

describe('attachmentTelemetry', () => {
  it('summarises an empty list without inventing a size bucket', () => {
    expect(attachmentTelemetry([])).toEqual({
      attachment_count: 0,
      attachment_kinds: [],
      attachment_exts: [],
      attachment_size_bucket: 'unknown',
      parse_modes: [],
      injection_modes: [],
      chunk_count_total: 0,
    })
    expect(attachmentTelemetry(null).attachment_count).toBe(0)
  })

  it('summarises kinds, extensions, modes and totals', () => {
    const result = attachmentTelemetry([
      image('screenshot.png'),
      doc('quarterly-report.pdf', 'pdf'),
    ])
    expect(result.attachment_count).toBe(2)
    expect(result.attachment_kinds).toEqual(['document', 'image'])
    expect(result.attachment_exts).toEqual(['pdf', 'png'])
    expect(result.parse_modes).toEqual(['auto'])
    expect(result.injection_modes).toEqual(['embeddings'])
    expect(result.chunk_count_total).toBe(12)
    expect(result.attachment_size_bucket).toBe('lt_500mb')
  })

  it('prefers the parsed fileType over the filename', () => {
    // Filename says .txt, the parser resolved it as docx — trust the parser.
    const result = attachmentTelemetry([doc('resume.txt', 'docx')])
    expect(result.attachment_exts).toEqual(['docx'])
  })

  it('leaks no filename or path into the payload', () => {
    const result = attachmentTelemetry([
      doc('alice-medical-history.pdf', 'pdf'),
      image('C:\\Users\\bob\\passport-scan.png'),
    ])
    const serialized = JSON.stringify(result)
    for (const secret of [
      'alice',
      'bob',
      'medical',
      'passport',
      'Users',
      'Documents',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('collapses unsupported extensions instead of echoing them', () => {
    const result = attachmentTelemetry([
      { name: 'secret-project.kdbx', type: 'document', size: 10 },
    ])
    expect(result.attachment_exts).toEqual(['other'])
  })
})

describe('codeBlockCount', () => {
  it('counts fenced blocks, not fences', () => {
    expect(codeBlockCount('```ts\nx\n```')).toBe(1)
    expect(codeBlockCount('```\na\n```\ntext\n```\nb\n```')).toBe(2)
  })

  it('is zero for prose, empty and missing input', () => {
    expect(codeBlockCount('just prose')).toBe(0)
    expect(codeBlockCount('')).toBe(0)
    expect(codeBlockCount(null)).toBe(0)
  })

  it('ignores an unclosed fence', () => {
    expect(codeBlockCount('```ts\nnever closed')).toBe(0)
  })
})

describe('contextTelemetry', () => {
  it('reports unknown usage when the token count is not yet known', () => {
    expect(contextTelemetry(null, 8192)).toEqual({
      ctx_len: 8192,
      ctx_used_pct_bucket: 'unknown',
    })
  })

  it('buckets real usage', () => {
    expect(contextTelemetry(7000, 8192).ctx_used_pct_bucket).toBe('75_90')
  })
})

describe('toolTelemetry', () => {
  const rag = new Set(['retrieve_documents'])
  const mcp = new Set(['acme_internal_lookup'])

  it('counts and classifies tool usage', () => {
    const result = toolTelemetry(
      ['retrieve_documents', 'acme_internal_lookup'],
      rag,
      mcp
    )
    expect(result.tool_call_count).toBe(2)
    expect(result.has_rag).toBe(true)
    expect(result.has_mcp).toBe(true)
    expect(result.tool_names).toContain('retrieve_documents')
    expect(JSON.stringify(result.tool_names)).not.toContain('acme')
  })

  it('is empty and false for a turn with no tools', () => {
    expect(toolTelemetry([], rag, mcp)).toEqual({
      tool_call_count: 0,
      tool_names: [],
      has_rag: false,
      has_mcp: false,
    })
  })
})

describe('responseShapeFromMessage', () => {
  const message = {
    parts: [
      { type: 'reasoning', text: 'thinking about it' },
      { type: 'text', text: 'Here you go:\n```ts\nconst a = 1\n```' },
      { type: 'tool-retrieve_documents', text: '' },
    ],
    metadata: {
      finishReason: 'stop',
      ttftMs: 320,
      activityDurationMs: 4100,
      usage: { inputTokens: 800, outputTokens: 120, totalTokens: 920 },
      tokenSpeed: {
        tokenSpeed: 41.5,
        durationMs: 2890,
        draftTokensTotal: 60,
        draftTokensAccepted: 45,
      },
    },
  }

  it('extracts shape, tools and engine numbers', () => {
    const shape = responseShapeFromMessage(
      message,
      new Set(['retrieve_documents'])
    )
    expect(shape.response_len_bucket).toBe('lt_100')
    expect(shape.has_reasoning).toBe(true)
    expect(shape.code_block_count).toBe(1)
    expect(shape.tool_call_count).toBe(1)
    expect(shape.tool_names).toEqual(['retrieve_documents'])
    expect(shape.finish_reason).toBe('stop')
    expect(shape.ttft_ms).toBe(320)
    expect(shape.total_duration_ms).toBe(4100)
    expect(shape.decode_duration_ms).toBe(2890)
    expect(shape.tps).toBe(41.5)
    expect(shape.tokens_in).toBe(800)
    expect(shape.tokens_out).toBe(120)
    expect(shape.tokens_total).toBe(920)
    expect(shape.draft_tokens_total).toBe(60)
    expect(shape.draft_tokens_accepted).toBe(45)
  })

  it('never carries the response text itself', () => {
    const shape = responseShapeFromMessage(message)
    const serialized = JSON.stringify(shape)
    expect(serialized).not.toContain('Here you go')
    expect(serialized).not.toContain('const a = 1')
    expect(serialized).not.toContain('thinking about it')
  })

  it('degrades to nulls rather than throwing on a bare message', () => {
    const shape = responseShapeFromMessage({})
    expect(shape.response_len_bucket).toBe('empty')
    expect(shape.has_reasoning).toBe(false)
    expect(shape.tokens_out).toBeNull()
    expect(shape.finish_reason).toBeNull()
    expect(responseShapeFromMessage(null).tps).toBeNull()
  })
})

describe('agentOutcome / agentResponseShape', () => {
  it('maps agent finish reasons onto chat outcomes', () => {
    expect(agentOutcome('reply')).toBe('success')
    expect(agentOutcome('finish')).toBe('success')
    // Hitting the step cap still produced a turn; `finish_reason` keeps it
    // distinguishable without calling it a failure.
    expect(agentOutcome('max_steps')).toBe('success')
    expect(agentOutcome('cancelled')).toBe('aborted')
    expect(agentOutcome('failed')).toBe('error')
    expect(agentOutcome(undefined)).toBe('success')
  })

  it('derives duration and tool usage from the run trace', () => {
    const shape = agentResponseShape({
      startedAtMs: 1000,
      finishedAtMs: 4500,
      trace: {
        assistantText: 'done',
        reasoning: { 0: 'step one' },
        tools: [
          { call: { tool: 'read_file' } },
          { call: { tool: 'read_file' } },
        ],
        finishReason: 'finish',
        stepCount: 3,
      },
    })
    expect(shape.total_duration_ms).toBe(3500)
    expect(shape.agent_step_count).toBe(3)
    expect(shape.tool_call_count).toBe(2)
    expect(shape.has_reasoning).toBe(true)
    expect(shape.response_len_bucket).toBe('lt_100')
    expect(JSON.stringify(shape)).not.toContain('step one')
  })

  it('survives a run with no trace', () => {
    const shape = agentResponseShape(null)
    expect(shape.total_duration_ms).toBeNull()
    expect(shape.tool_call_count).toBe(0)
  })
})

describe('turn id correlation', () => {
  it('gives the request and the response the same id', () => {
    const thread = `t-${Math.random()}`
    const sent = beginChatTurn(thread)
    expect(currentChatTurn(thread)).toBe(sent)
  })

  it('mints a fresh id for a response with no tracked send', () => {
    const thread = `t-${Math.random()}`
    expect(currentChatTurn(thread)).toMatch(/.+/)
  })

  it('releases the id once the turn is reported', () => {
    const thread = `t-${Math.random()}`
    const first = beginChatTurn(thread)
    captureChatResponse({
      turn_id: first,
      thread_id: thread,
      source: 'chat',
      outcome: 'success',
    })
    // A continuation is a second model call and must not be deduped away.
    expect(currentChatTurn(thread)).not.toBe(first)
  })
})

describe('captureChatResponse', () => {
  const base = (turnId: string, thread: string) => ({
    turn_id: turnId,
    thread_id: thread,
    source: 'chat' as const,
    outcome: 'success' as const,
  })

  it('emits exactly once per turn', () => {
    const thread = `t-${Math.random()}`
    const turn = beginChatTurn(thread)
    captureChatResponse(base(turn, thread))
    captureChatResponse(base(turn, thread))
    expect(captured().filter((c) => c[0] === 'chat_response_received')).toHaveLength(1)
  })

  it('classifies the error and reports its status without the message', () => {
    const thread = `t-${Math.random()}`
    captureChatResponse({
      turn_id: beginChatTurn(thread),
      thread_id: thread,
      source: 'chat',
      outcome: 'error',
      model_id: `m-${Math.random()}`,
      error: new Error(
        'Request failed with status code 429 for /Users/alice/model.gguf'
      ),
    })
    const props = captured()[0][1] as Record<string, unknown>
    expect(props.error_kind).toBe('rate_limit')
    expect(props.http_status).toBe(429)
    // The raw error must never ride along.
    expect(JSON.stringify(props)).not.toContain('alice')
    expect(props.error).toBeUndefined()
  })

  it('leaves error_kind null on a successful turn', () => {
    const thread = `t-${Math.random()}`
    captureChatResponse(base(beginChatTurn(thread), thread))
    const props = captured()[0][1] as Record<string, unknown>
    expect(props.error_kind).toBeNull()
  })

  it('derives the backend from the provider', () => {
    const thread = `t-${Math.random()}`
    captureChatResponse({
      ...base(beginChatTurn(thread), thread),
      provider: 'llamacpp',
    })
    expect((captured()[0][1] as Record<string, unknown>).backend).toBe(
      'llamacpp'
    )
  })

  it('throttles a repeated identical failure', () => {
    const thread1 = `t-${Math.random()}`
    const thread2 = `t-${Math.random()}`
    const model = `m-${Math.random()}`
    captureChatResponse({
      turn_id: beginChatTurn(thread1),
      thread_id: thread1,
      source: 'chat',
      outcome: 'error',
      model_id: model,
      error: 'ggml out of memory',
    })
    captureChatResponse({
      turn_id: beginChatTurn(thread2),
      thread_id: thread2,
      source: 'chat',
      outcome: 'error',
      model_id: model,
      error: 'ggml out of memory',
    })
    expect(captured()).toHaveLength(1)
  })
})

describe('captureChatRequest', () => {
  it('derives has_attachments from the count', () => {
    const thread = `t-${Math.random()}`
    captureChatRequest({
      turn_id: beginChatTurn(thread),
      thread_id: thread,
      source: 'chat',
      attachment_count: 2,
    })
    const props = captured()[0][1] as Record<string, unknown>
    expect(captured()[0][0]).toBe('chat_request_sent')
    expect(props.has_attachments).toBe(true)
  })

  it('reports no attachments when none were sent', () => {
    const thread = `t-${Math.random()}`
    captureChatRequest({
      turn_id: beginChatTurn(thread),
      thread_id: thread,
      source: 'chat',
    })
    expect((captured()[0][1] as Record<string, unknown>).has_attachments).toBe(
      false
    )
  })
})

describe('PII contract', () => {
  /**
   * Guards the promise made in Settings → Privacy ("we never collect your
   * personal information or chat content"). Any future property that carries
   * free-form text will trip this.
   */
  it('emits only enums, ids, numbers, buckets and booleans', () => {
    const thread = `t-${Math.random()}`
    captureChatResponse({
      ...responseShapeFromMessage({
        parts: [
          { type: 'text', text: 'A very long confidential answer '.repeat(50) },
          { type: 'reasoning', text: 'private chain of thought' },
        ],
        metadata: { finishReason: 'stop' },
      }),
      ...attachmentTelemetry([doc('board-minutes.pdf', 'pdf')]),
      ...contextTelemetry(4000, 8192),
      turn_id: beginChatTurn(thread),
      thread_id: thread,
      source: 'chat',
      outcome: 'success',
      model_id: 'org/model-Q4_K_M',
      provider: 'llamacpp',
    })

    const props = captured()[0][1] as Record<string, unknown>
    const forbiddenKeys = ['name', 'path', 'text', 'content', 'prompt', 'error']
    for (const key of Object.keys(props)) {
      expect(forbiddenKeys).not.toContain(key)
    }
    for (const [key, value] of Object.entries(props)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === 'string') {
          // Long strings are how free-form text would sneak in; ids and enums
          // are all comfortably short.
          expect(
            item.length,
            `${key} carried a suspiciously long string`
          ).toBeLessThanOrEqual(64)
        }
      }
    }
  })
})
