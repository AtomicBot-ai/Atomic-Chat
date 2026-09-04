import type { UIMessage } from '@ai-sdk/react'
import { jsonSchema, type Tool } from 'ai'

import type { MCPTool } from '@/types/completion'

const LLAMA_GRAMMAR_EXPANSION_KEYS = new Set([
  'format',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'pattern',
  'patternProperties',
])

const SCHEMA_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'properties',
])

const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

const SCHEMA_VALUE_KEYS = new Set([
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Remove only the JSON Schema constraints that llama.cpp expands into large
 * bounded GBNF repetitions. The MCP server remains the authority for those
 * limits when it validates the eventual tool call.
 */
export function makeLlamaGrammarSafeSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  const visitSchema = (value: unknown): unknown => {
    if (!isRecord(value)) return value

    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (LLAMA_GRAMMAR_EXPANSION_KEYS.has(key)) continue

      if (SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
        result[key] = Object.fromEntries(
          Object.entries(child).map(([name, nested]) => [
            name,
            visitSchema(nested),
          ])
        )
      } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
        result[key] = child.map(visitSchema)
      } else if (SCHEMA_VALUE_KEYS.has(key)) {
        result[key] = Array.isArray(child)
          ? child.map(visitSchema)
          : visitSchema(child)
      } else if (key === 'dependencies' && isRecord(child)) {
        result[key] = Object.fromEntries(
          Object.entries(child).map(([name, nested]) => [
            name,
            Array.isArray(nested) ? nested : visitSchema(nested),
          ])
        )
      } else {
        result[key] = child
      }
    }
    return result
  }

  return visitSchema(schema) as Record<string, unknown>
}

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
  disabledToolKeys: readonly string[],
  options: { llamaGrammarSafe?: boolean } = {}
): Record<string, Tool> {
  const disabled = new Set(disabledToolKeys)
  const toolsRecord: Record<string, Tool> = {}

  for (const tool of [...ragTools, ...mcpTools]) {
    const serverName = tool.server || 'unknown'
    if (disabled.has(`${serverName}::${tool.name}`)) continue

    const inputSchema = options.llamaGrammarSafe
      ? makeLlamaGrammarSafeSchema(tool.inputSchema)
      : tool.inputSchema
    toolsRecord[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(inputSchema),
    } as Tool
  }

  return Object.fromEntries(
    Object.entries(toolsRecord).sort(([a], [b]) => a.localeCompare(b))
  )
}
