import type { UIMessage } from '@ai-sdk/react'
import { jsonSchema, type Tool } from 'ai'

import { toolJsonSchema } from '@/lib/prompt-size'
import type { MCPTool } from '@/types/completion'

export function splitAnthropicSerialToolUse(
  messages: UIMessage[]
): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== 'assistant') return [message]

    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.length === 0) return [message]

    const waves: (typeof parts)[] = []
    let currentWave: typeof parts = []
    let seenToolParts = false

    for (const part of parts) {
      if (part.type.startsWith('tool-')) {
        seenToolParts = true
        currentWave.push(part)
      } else if (seenToolParts) {
        waves.push(currentWave)
        currentWave = [part]
        seenToolParts = false
      } else {
        currentWave.push(part)
      }
    }
    if (currentWave.length > 0) waves.push(currentWave)

    if (waves.length <= 1) return [message]

    return waves.map((waveParts, index) => ({
      ...message,
      id: `${message.id}_w${index}`,
      parts: waveParts,
    }))
  })
}

export function buildToolsRecord(
  ragTools: readonly MCPTool[],
  mcpTools: readonly MCPTool[],
  disabledToolKeys: readonly string[]
): Record<string, Tool> {
  const disabled = new Set(disabledToolKeys)
  const toolsRecord: Record<string, Tool> = {}

  for (const tool of [...ragTools, ...mcpTools]) {
    const serverName = tool.server || 'unknown'
    if (disabled.has(`${serverName}::${tool.name}`)) continue

    toolsRecord[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.inputSchema),
    } as Tool
  }

  return Object.fromEntries(
    Object.entries(toolsRecord).sort(([a], [b]) => a.localeCompare(b))
  )
}

/// Size bounds llama.cpp compiles into literal grammar repetitions.
const SCHEMA_SIZE_BOUND_KEYS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
])

/// Keys whose value is a map of *name -> schema*, not a schema itself. A tool
/// is free to declare a property called `maxLength`, so the bound keys above
/// must only be matched one level deeper.
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
])

/// Largest `{m,n}` a regex may ask for before `pattern` is dropped too. Real
/// patterns quantify over host labels and uuid groups (`{0,61}`, `{4}`); a
/// bound this big is a length check smuggled into a regex, and llama.cpp
/// expands it exactly like `maxLength`. Well under the ~2000 the parser
/// tolerates, with room for the rest of the catalogue's rules.
const MAX_PATTERN_REPETITION = 256

function patternIsGrammarSafe(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return true
  for (const match of pattern.matchAll(/\{\d*,(\d+)\}|\{(\d+)\}/g)) {
    const bound = Number(match[1] ?? match[2])
    if (bound > MAX_PATTERN_REPETITION) return false
  }
  return true
}

function stripSizeBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSizeBounds)
  if (!node || typeof node !== 'object') return node

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (SCHEMA_SIZE_BOUND_KEYS.has(key)) continue
    if (key === 'pattern' && !patternIsGrammarSafe(value)) continue
    result[key] = SCHEMA_MAP_KEYS.has(key)
      ? stripSizeBoundsInSchemaMap(value)
      : stripSizeBounds(value)
  }
  return result
}

function stripSizeBoundsInSchemaMap(node: unknown): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return stripSizeBounds(node)
  }
  return Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([name, schema]) => [
      name,
      stripSizeBounds(schema),
    ])
  )
}

/**
 * Drop `minLength` / `maxLength` / `minItems` / `maxItems` — and any `pattern`
 * quantifying past `MAX_PATTERN_REPETITION` — from every tool schema in the
 * record.
 *
 * llama.cpp compiles the tool schemas into one GBNF grammar and samples
 * against it, and a size bound becomes a literal repetition there:
 * `maxLength: 10000` on a string turns into `char{0,10000}`. Its grammar
 * parser rejects repetitions that large ("number of repetitions exceeds sane
 * defaults"), and the grammar covers the WHOLE catalogue — so one oversized
 * bound in one tool of one connector fails every request on that engine with
 * `Failed to initialize samplers: failed to parse grammar`, tool call or not.
 * Firecrawl's `maxLength: 10000` prompt fields do exactly that.
 *
 * The bounds buy us nothing: the MCP server validates its own arguments, and
 * without them llama.cpp emits unbounded `char*` / `item*` rules that impose
 * no repetition at all. Applied only to the grammar-constrained engines; every
 * other provider keeps the schemas exactly as the server published them.
 */
export function withGrammarSafeToolSchemas(
  tools: Record<string, Tool> | undefined
): Record<string, Tool> | undefined {
  if (!tools) return tools
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        inputSchema: jsonSchema(
          stripSizeBounds(toolJsonSchema(tool)) as Parameters<
            typeof jsonSchema
          >[0]
        ),
      } as Tool,
    ])
  )
}
