import { generateId, type LanguageModelMiddleware } from 'ai'

/**
 * Tool calls a server streams back as plain text, turned into real tool calls.
 *
 * Foundry Local (ONNX Runtime GenAI behind oatpp) passes `tools` to the model
 * but does not parse what the model answers: a Qwen3.5 model's call arrives as
 * `content` deltas — `<function=run_command>\n<parameter=command>\ndir\n</parameter>\n</function>`
 * — with `finish_reason: "stop"` and no `tool_calls`, and the `<tool_call>`
 * wrapper (a special token) already stripped. The chat then showed the XML and
 * ran nothing. llama.cpp does this conversion server-side; here it happens on
 * the way in.
 *
 * Recognised: the XML form above (Qwen3.5, Qwen3-Coder) and the JSON form
 * `<tool_call>{"name": …, "arguments": {…}}</tool_call>` (Hermes, Qwen2.5).
 * Only names among the request's tools become calls; text that does not parse
 * is passed through unchanged, so nothing the model wrote is lost.
 */

type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>
type StreamResult = Awaited<ReturnType<WrapStream>>
type StreamPart =
  StreamResult['stream'] extends ReadableStream<infer P> ? P : never
type CallOptions = Parameters<WrapStream>[0]['params']
type GenerateResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware['wrapGenerate']>>
>
type ContentPart = GenerateResult['content'][number]

const MARKERS = ['<function=', '<tool_call>'] as const

type ToolSchemas = Map<string, Record<string, unknown> | undefined>

export type ParsedToolCall = { toolName: string; input: string }

/** The request's function tools by name, with their JSON input schemas. */
function toolSchemas(params: CallOptions): ToolSchemas {
  const schemas: ToolSchemas = new Map()
  for (const tool of params.tools ?? []) {
    if (tool.type === 'function') {
      schemas.set(tool.name, tool.inputSchema as Record<string, unknown>)
    }
  }
  return schemas
}

/** Where a marker starts in `text`, or -1. */
function markerIndex(text: string): number {
  const hits = MARKERS.map((marker) => text.indexOf(marker)).filter(
    (index) => index >= 0
  )
  return hits.length > 0 ? Math.min(...hits) : -1
}

/**
 * How many trailing characters could still grow into a marker (`<func` at the
 * end of a delta): they are held back until the next delta decides.
 */
function heldSuffixLength(text: string): number {
  let held = 0
  for (const marker of MARKERS) {
    for (let length = Math.min(marker.length - 1, text.length); length > held; length--) {
      if (text.endsWith(marker.slice(0, length))) {
        held = length
        break
      }
    }
  }
  return held
}

/** An XML parameter value is text; the tool's schema says what it really is. */
function coerce(value: string, schema: unknown): unknown {
  const type = (schema as { type?: unknown } | undefined)?.type
  if (type === 'string' || type === undefined) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** One newline on each side belongs to the format, not to the value. */
function trimFormatNewlines(value: string): string {
  return value.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
}

function parseXmlCall(
  name: string,
  body: string,
  schemas: ToolSchemas
): ParsedToolCall | null {
  if (!schemas.has(name)) return null
  const properties =
    (schemas.get(name)?.properties as Record<string, unknown> | undefined) ?? {}
  const args: Record<string, unknown> = {}
  const parameter = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g
  for (const match of body.matchAll(parameter)) {
    const key = match[1]
    args[key] = coerce(trimFormatNewlines(match[2]), properties[key])
  }
  return { toolName: name, input: JSON.stringify(args) }
}

function parseJsonCall(json: string, schemas: ToolSchemas): ParsedToolCall | null {
  try {
    const parsed = JSON.parse(json) as { name?: unknown; arguments?: unknown }
    if (typeof parsed.name !== 'string' || !schemas.has(parsed.name)) return null
    const args =
      typeof parsed.arguments === 'string'
        ? JSON.parse(parsed.arguments)
        : (parsed.arguments ?? {})
    return { toolName: parsed.name, input: JSON.stringify(args) }
  } catch {
    return null
  }
}

/**
 * Split text that starts at a marker into the calls it holds and the text
 * around them. A block that does not parse (unknown tool, broken JSON) stays
 * text. A trailing `</function>` the model never wrote still closes the call.
 */
export function parseTextToolCalls(
  text: string,
  schemas: ToolSchemas
): { calls: ParsedToolCall[]; text: string } {
  const calls: ParsedToolCall[] = []
  const block =
    /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>|(?:<tool_call>\s*)?<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)(?:\s*<\/tool_call>)?/g
  const rest = text.replace(block, (whole, json, name, body) => {
    const call =
      json !== undefined
        ? parseJsonCall(json, schemas)
        : parseXmlCall(name, body, schemas)
    if (!call) return whole
    calls.push(call)
    return ''
  })
  return { calls, text: calls.length > 0 ? rest.trim() : text }
}

export function textToolCallMiddleware(): LanguageModelMiddleware {
  return {
    middlewareVersion: 'v2',

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate()
      const schemas = toolSchemas(params)
      if (schemas.size === 0) return result
      const content: ContentPart[] = []
      let found = false
      for (const part of result.content) {
        if (part.type !== 'text' || markerIndex(part.text) < 0) {
          content.push(part)
          continue
        }
        const { calls, text } = parseTextToolCalls(part.text, schemas)
        if (text) content.push({ ...part, text })
        for (const call of calls) {
          found = true
          content.push({
            type: 'tool-call',
            toolCallId: generateId(),
            toolName: call.toolName,
            input: call.input,
          })
        }
      }
      return found
        ? { ...result, content, finishReason: 'tool-calls' }
        : result
    },

    wrapStream: async ({ doStream, params }) => {
      const result = await doStream()
      const schemas = toolSchemas(params)
      if (schemas.size === 0) return result

      // Per text part: what is held back, whether a call has started, and
      // whether its `text-start` went out yet (it waits for real text, so a
      // call alone opens no empty message; whitespace before it waits too).
      type TextState = {
        start: StreamPart
        started: boolean
        leading: string
        pending: string
        capturing: boolean
      }
      const texts = new Map<string, TextState>()
      let emittedCalls = false

      const emitText = (
        state: TextState,
        id: string,
        delta: string,
        controller: TransformStreamDefaultController<StreamPart>
      ) => {
        if (!delta) return
        if (!state.started) {
          if (!delta.trim()) {
            state.leading += delta
            return
          }
          controller.enqueue(state.start)
          state.started = true
          delta = state.leading + delta
          state.leading = ''
        }
        controller.enqueue({ type: 'text-delta', id, delta } as StreamPart)
      }

      const close = (
        id: string,
        end: StreamPart | undefined,
        controller: TransformStreamDefaultController<StreamPart>
      ) => {
        const state = texts.get(id)
        if (!state) return
        texts.delete(id)
        let calls: ParsedToolCall[] = []
        if (state.capturing) {
          const parsed = parseTextToolCalls(state.pending, schemas)
          calls = parsed.calls
          emitText(state, id, parsed.text, controller)
        } else {
          emitText(state, id, state.pending, controller)
        }
        // Whitespace that turned out to lead to nothing but a call is dropped;
        // an answer that is only whitespace still goes out as it was.
        if (!state.started && state.leading && calls.length === 0) {
          controller.enqueue(state.start)
          controller.enqueue({
            type: 'text-delta',
            id,
            delta: state.leading,
          } as StreamPart)
          state.started = true
        }
        if (state.started) {
          controller.enqueue(end ?? ({ type: 'text-end', id } as StreamPart))
        }
        for (const call of calls) {
          emittedCalls = true
          controller.enqueue({
            type: 'tool-call',
            toolCallId: generateId(),
            toolName: call.toolName,
            input: call.input,
          } as StreamPart)
        }
      }

      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<StreamPart, StreamPart>({
            transform(chunk, controller) {
              if (chunk.type === 'text-start') {
                texts.set(chunk.id, {
                  start: chunk,
                  started: false,
                  leading: '',
                  pending: '',
                  capturing: false,
                })
                return
              }
              if (chunk.type === 'text-delta') {
                const state = texts.get(chunk.id)
                if (!state) {
                  controller.enqueue(chunk)
                  return
                }
                state.pending += chunk.delta
                if (state.capturing) return
                const at = markerIndex(state.pending)
                if (at >= 0) {
                  emitText(state, chunk.id, state.pending.slice(0, at), controller)
                  state.pending = state.pending.slice(at)
                  state.capturing = true
                  return
                }
                const held = heldSuffixLength(state.pending)
                emitText(
                  state,
                  chunk.id,
                  state.pending.slice(0, state.pending.length - held),
                  controller
                )
                state.pending = state.pending.slice(state.pending.length - held)
                return
              }
              if (chunk.type === 'text-end') {
                close(chunk.id, chunk, controller)
                return
              }
              if (chunk.type === 'finish') {
                for (const id of [...texts.keys()]) close(id, undefined, controller)
                controller.enqueue(
                  emittedCalls
                    ? { ...chunk, finishReason: 'tool-calls' }
                    : chunk
                )
                return
              }
              controller.enqueue(chunk)
            },
            flush(controller) {
              for (const id of [...texts.keys()]) close(id, undefined, controller)
            },
          })
        ),
      }
    },
  }
}
