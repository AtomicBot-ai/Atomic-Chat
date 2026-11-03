/**
 * What a chat request to a LiteRT-LM session may carry (change `add-litert-lm-runtime`).
 *
 * The local streaming fetch merges the model's llama.cpp-shaped parameter bag into every body. The
 * core's LiteRT-LM host serves its own OpenAI server (spec `litert-lm-runtime`, "Сервер хоста
 * отвечает как OpenAI chat completions"): it reads the OpenAI chat fields plus `top_k`,
 * `response_format` (constrained decoding) and the thinking switch (`chat_template_kwargs.
 * enable_thinking`, `reasoning_effort`), ignores unknown fields and answers 400 to a value it does
 * not support. So the body is cut down to what it reads — no llama.cpp knobs — and a `tool_choice`
 * other than `auto`/`none` is left out rather than refused: `auto` is the host's default.
 */

const PASSED_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'top_k',
  'seed',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'response_format',
  'chat_template_kwargs',
  'reasoning_effort',
])

const HOST_TOOL_CHOICES: ReadonlySet<unknown> = new Set(['auto', 'none'])

/** The body cut down to what the LiteRT-LM host reads; `tool_choice` only with `tools`. */
export function liteRtLmRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const shaped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (PASSED_FIELDS.has(key)) shaped[key] = value
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    shaped.tools = body.tools
    if (HOST_TOOL_CHOICES.has(body.tool_choice)) shaped.tool_choice = body.tool_choice
  }
  return shaped
}
