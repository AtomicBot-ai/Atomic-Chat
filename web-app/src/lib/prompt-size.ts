import type { ModelMessage, Tool } from 'ai'

/**
 * Token estimate with the same shape as the Rust agent's
 * `token_budget.rs::estimate_tokens`: the larger of a character-based and a
 * word-based guess, so dense JSON (few words, many chars) and prose (many
 * short words) are both bounded from above.
 */
export const CHARS_PER_TOKEN = 3.6
export const WORDS_PER_TOKEN = 1.4

/** Per-tool wrapper the chat template adds around each JSON schema. */
export const TOOL_TEMPLATE_OVERHEAD_TOKENS = 12
/** Per-message wrapper (role tags, separators). */
export const MESSAGE_TEMPLATE_OVERHEAD_TOKENS = 4
/** Output room reserved when the request carries no `max_output_tokens`. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 1024
/** Fraction of the context a prompt may use before the window is grown. */
export const PREFLIGHT_CTX_THRESHOLD = 0.9

export function estimateTokens(text: string): number {
  if (!text) return 0
  const byChars = Math.ceil(text.length / CHARS_PER_TOKEN)
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const byWords = Math.ceil(words * WORDS_PER_TOKEN)
  return Math.max(byChars, byWords)
}

/** The plain JSON schema behind an AI SDK tool (unwraps `jsonSchema()`). */
export function toolJsonSchema(tool: Tool): unknown {
  const schema = tool.inputSchema as unknown
  if (schema && typeof schema === 'object' && 'jsonSchema' in schema) {
    return (schema as { jsonSchema: unknown }).jsonSchema
  }
  return schema
}

export function estimateToolTokens(name: string, tool: Tool): number {
  const rendered = JSON.stringify({
    name,
    description: tool.description ?? '',
    parameters: toolJsonSchema(tool) ?? {},
  })
  return estimateTokens(rendered) + TOOL_TEMPLATE_OVERHEAD_TOKENS
}

export function estimateToolsTokens(
  tools: Record<string, Tool> | undefined
): number {
  if (!tools) return 0
  return Object.entries(tools).reduce(
    (sum, [name, tool]) => sum + estimateToolTokens(name, tool),
    0
  )
}

/** Text carried by one model message: string content or its text parts. */
export function messageText(message: ModelMessage): string {
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // The part unions differ per message role; read the few fields we need
  // structurally rather than switching on every variant.
  return (content as readonly unknown[])
    .map((raw) => {
      const part = raw as {
        type?: unknown
        text?: unknown
        toolName?: unknown
        input?: unknown
        output?: unknown
      }
      if (typeof part.text === 'string') return part.text
      if (part.type === 'tool-call') {
        return JSON.stringify({ name: part.toolName, input: part.input })
      }
      if (part.type === 'tool-result') {
        return JSON.stringify(part.output ?? '')
      }
      return ''
    })
    .join('\n')
}

export function estimatePromptTokensHeuristic(args: {
  system?: string
  messages: readonly ModelMessage[]
  tools?: Record<string, Tool>
}): number {
  const system = args.system ? estimateTokens(args.system) : 0
  const messages = args.messages.reduce(
    (sum, message) =>
      sum + estimateTokens(messageText(message)) + MESSAGE_TEMPLATE_OVERHEAD_TOKENS,
    0
  )
  return system + messages + estimateToolsTokens(args.tools)
}

/** OpenAI-style wire shape of a tool set, as llama-server's `/apply-template` expects it. */
export function toOpenAiTools(
  tools: Record<string, Tool> | undefined
): Array<{
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}> {
  if (!tools) return []
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function' as const,
    function: {
      name,
      description: tool.description,
      parameters: toolJsonSchema(tool) ?? { type: 'object', properties: {} },
    },
  }))
}

/**
 * OpenAI-style messages for `/apply-template`. Text-only: images and audio
 * are dropped (their token cost is engine-specific), tool calls / results
 * are serialised as text so the template still counts them roughly.
 */
export function toOpenAiMessages(args: {
  system?: string
  messages: readonly ModelMessage[]
}): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = []
  if (args.system) out.push({ role: 'system', content: args.system })
  for (const message of args.messages) {
    out.push({ role: message.role, content: messageText(message) })
  }
  return out
}
