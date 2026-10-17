import { describe, expect, it } from 'vitest'
import {
  parseTextToolCalls,
  textToolCallMiddleware,
} from '../text-tool-call-middleware'

type Part = Record<string, unknown> & { type: string }

const RUN_COMMAND = {
  type: 'function',
  name: 'run_command',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_seconds: { type: 'integer' },
    },
  },
}

const params = (tools: unknown[] = [RUN_COMMAND]) =>
  ({ prompt: [], tools }) as never

/** What Foundry Local streamed for a Qwen3.5 call, delta by delta. */
const FOUNDRY_DELTAS = [
  '',
  '\n',
  '<function',
  '=',
  'run',
  '_',
  'command',
  '>',
  '\n',
  '<parameter',
  '=',
  'command',
  '>',
  '\n',
  'dir',
  ' "',
  'C',
  ':\\',
  'Users',
  '\\',
  'Downloads',
  '"',
  ' /b',
  '\n',
  '</parameter>',
  '\n',
  '</function>',
  '\n\n',
]

async function run(deltas: string[], tools?: unknown[]): Promise<Part[]> {
  const chunks: Part[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...deltas.map((delta) => ({ type: 'text-delta', id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: 'stop', usage: {} },
  ]
  const stream = new ReadableStream<Part>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })
  const middleware = textToolCallMiddleware()
  const result = await middleware.wrapStream!({
    doStream: async () => ({ stream }) as never,
    doGenerate: async () => ({}) as never,
    params: params(tools),
    model: {} as never,
  })
  const out: Part[] = []
  const reader = (result.stream as ReadableStream<Part>).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

const text = (parts: Part[]) =>
  parts
    .filter((part) => part.type === 'text-delta')
    .map((part) => part.delta)
    .join('')
const calls = (parts: Part[]) =>
  parts
    .filter((part) => part.type === 'tool-call')
    .map((part) => ({ toolName: part.toolName, input: JSON.parse(part.input as string) }))
const finish = (parts: Part[]) =>
  parts.find((part) => part.type === 'finish')?.finishReason

describe('textToolCallMiddleware (stream)', () => {
  it("turns Foundry Local's streamed XML into one real call and no text", async () => {
    const out = await run(FOUNDRY_DELTAS)

    expect(calls(out)).toEqual([
      { toolName: 'run_command', input: { command: 'dir "C:\\Users\\Downloads" /b' } },
    ])
    expect(text(out)).toBe('')
    // Nothing to show: the text part never opens.
    expect(out.some((part) => part.type === 'text-start')).toBe(false)
    expect(finish(out)).toBe('tool-calls')
    // The call goes out before the finish the chat acts on.
    const order = out.map((part) => part.type)
    expect(order.indexOf('tool-call')).toBeLessThan(order.indexOf('finish'))
  })

  it('keeps what the model said before the call', async () => {
    const out = await run(['Let me look.', '\n<function=run_command>\n<parameter=command>\ndir\n</parameter>\n</function>'])

    expect(text(out)).toBe('Let me look.\n')
    expect(calls(out)).toEqual([{ toolName: 'run_command', input: { command: 'dir' } }])
  })

  it('passes ordinary text through, a "<" that starts no call included', async () => {
    const out = await run(['a < b and <b>bold</b>', ' and <fun', 'ny> text'])

    expect(text(out)).toBe('a < b and <b>bold</b> and <funny> text')
    expect(calls(out)).toEqual([])
    expect(finish(out)).toBe('stop')
  })

  it('leaves a call to a tool the request did not offer as text', async () => {
    const xml = '<function=delete_everything>\n<parameter=path>\n/\n</parameter>\n</function>'
    const out = await run([xml])

    expect(calls(out)).toEqual([])
    expect(text(out)).toBe(xml)
    expect(finish(out)).toBe('stop')
  })

  it('reads the JSON form and a marker split across deltas', async () => {
    const out = await run([
      '<tool_',
      'call>{"name": "run_command", "arguments": {"command": "ls", "timeout_seconds": 5}}</tool_call>',
    ])

    expect(calls(out)).toEqual([
      { toolName: 'run_command', input: { command: 'ls', timeout_seconds: 5 } },
    ])
  })

  it("gives an XML value the type the tool's schema asks for", async () => {
    const out = await run([
      '<function=run_command>\n<parameter=command>\necho 1\n</parameter>\n<parameter=timeout_seconds>\n30\n</parameter>\n</function>',
    ])

    expect(calls(out)[0].input).toEqual({ command: 'echo 1', timeout_seconds: 30 })
  })

  it('closes a call the model never closed', async () => {
    const out = await run(['<function=run_command>\n<parameter=command>\nver\n</parameter>\n'])

    expect(calls(out)).toEqual([{ toolName: 'run_command', input: { command: 'ver' } }])
  })

  it('touches nothing when the request offered no tools', async () => {
    const out = await run(FOUNDRY_DELTAS, [])

    expect(calls(out)).toEqual([])
    expect(text(out)).toBe(FOUNDRY_DELTAS.join(''))
    expect(finish(out)).toBe('stop')
  })
})

describe('textToolCallMiddleware (generate)', () => {
  it('splits a whole answer into its text and its calls', async () => {
    const middleware = textToolCallMiddleware()
    const result = await middleware.wrapGenerate!({
      doGenerate: async () =>
        ({
          content: [
            {
              type: 'text',
              text: 'Sure.\n<function=run_command>\n<parameter=command>\ndir\n</parameter>\n</function>',
            },
          ],
          finishReason: 'stop',
          usage: {},
          warnings: [],
        }) as never,
      doStream: async () => ({}) as never,
      params: params(),
      model: {} as never,
    })

    expect(result.finishReason).toBe('tool-calls')
    expect(result.content.map((part) => part.type)).toEqual(['text', 'tool-call'])
    expect((result.content[0] as { text: string }).text).toBe('Sure.')
  })
})

describe('parseTextToolCalls', () => {
  it('reads several calls in a row', () => {
    const schemas = new Map([['run_command', RUN_COMMAND.inputSchema]])
    const { calls: parsed, text: rest } = parseTextToolCalls(
      '<function=run_command>\n<parameter=command>\na\n</parameter>\n</function>\n<function=run_command>\n<parameter=command>\nb\n</parameter>\n</function>',
      schemas
    )

    expect(parsed.map((call) => JSON.parse(call.input).command)).toEqual(['a', 'b'])
    expect(rest).toBe('')
  })
})
