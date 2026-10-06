/**
 * What a chat request to a TensorRT-LLM session may carry, and how the engine's refusal reads
 * (task 3.13, manual-run finding F-8).
 *
 * `trtllm-serve`'s request models forbid unknown fields (pydantic `extra="forbid"`): one llama.cpp
 * knob in the body — `repeat_penalty`, `n_predict`, `cache_prompt`, … — and the whole request is a
 * `400 extra_forbidden`. The local streaming fetch merges the model's llama.cpp-shaped parameter bag
 * into every body, so for this engine the merged body is cut down to the fields it reads.
 */

/** The request itself: what the AI SDK always sends for a chat turn. */
const PROTOCOL_FIELDS = ['model', 'messages', 'stream', 'stream_options'] as const

/** Sampling and output fields `trtllm-serve` reads (the list of task 3.13). */
const SAMPLING_FIELDS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'chat_template_kwargs',
] as const

const PASSED_FIELDS: ReadonlySet<string> = new Set([
  ...PROTOCOL_FIELDS,
  ...SAMPLING_FIELDS,
])

/**
 * Whether the body asks for constrained output: a `response_format` other than `{"type": "text"}`.
 * The same rule the core's session gateway applies before it refuses the request for a family
 * without structured output.
 */
export function asksForStructuredOutput(body: Record<string, unknown>): boolean {
  const format = body.response_format
  if (format === null || typeof format !== 'object' || Array.isArray(format)) {
    return false
  }
  return (format as { type?: unknown }).type !== 'text'
}

/**
 * The body cut down to what `trtllm-serve` accepts. `tools` only when there are any, and
 * `tool_choice` only together with them: the engine refuses a `tool_choice` without `tools`.
 * `response_format` only when it asks for structured output and the model's family has it
 * (`structuredOutput`); a plain-text format is the default and is left out. Everything else — the
 * llama.cpp knobs, `parallel_tool_calls`, `reasoning_format`, `timings_per_token` — is dropped.
 */
export function tensorrtLlmRequestBody(
  body: Record<string, unknown>,
  options: { structuredOutput: boolean }
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (PASSED_FIELDS.has(key)) shaped[key] = value
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    shaped.tools = body.tools
    if (body.tool_choice !== undefined) shaped.tool_choice = body.tool_choice
  }
  if (options.structuredOutput && asksForStructuredOutput(body)) {
    shaped.response_format = body.response_format
  }
  return shaped
}

/**
 * `trtllm-serve`'s own error answer — `{"object":"error","message":…,"type":…,"code":400}`, which
 * the core's gateway relays as it is — rewritten into OpenAI's `{"error":{"message",…}}`. The AI
 * SDK reads only the OpenAI shape; any other body leaves it with the response's empty status text,
 * and the chat shows "Error generating response" with nothing under it. `null` when the body is
 * already OpenAI-shaped or carries no message to lift.
 */
export function openAIErrorBody(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  const error = record.error
  if (error !== null && typeof error === 'object') return null
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof error === 'string'
        ? error
        : typeof record.detail === 'string'
          ? record.detail
          : null
  if (message === null) return null
  return JSON.stringify({
    error: {
      message,
      type: typeof record.type === 'string' ? record.type : null,
      code: record.code ?? null,
    },
  })
}

/** A fetch whose error answers the AI SDK can read the engine's message from. */
export function createEngineErrorFetch<F extends (...args: never[]) => Promise<Response>>(
  inner: F
): F {
  return (async (...args: Parameters<F>) => {
    const response = await inner(...args)
    if (response.ok) return response
    const text = await response.text()
    return new Response(openAIErrorBody(text) ?? text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }) as F
}
