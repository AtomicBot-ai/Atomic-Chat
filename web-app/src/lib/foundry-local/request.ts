/**
 * What a chat request to a Foundry Local session may carry (change `add-foundry-local`).
 *
 * The local streaming fetch merges the model's llama.cpp-shaped parameter bag into every body.
 * Foundry Local's built-in server (ONNX Runtime GenAI behind oatpp) documents only the OpenAI chat
 * fields, and the core's gateway in front of it declares no structured output for the provider, so
 * the body is cut down to the OpenAI fields: no llama.cpp knobs, no `top_k`/`min_p`, no
 * `chat_template_kwargs`, no `response_format`. Reasoning is split by the library itself, on the
 * markers the variant was registered with.
 */

const PASSED_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
])

/** The body cut down to what Foundry Local reads; `tool_choice` only together with `tools`. */
export function foundryLocalRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const shaped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (PASSED_FIELDS.has(key)) shaped[key] = value
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    shaped.tools = body.tools
    if (body.tool_choice !== undefined) shaped.tool_choice = body.tool_choice
  }
  return shaped
}
