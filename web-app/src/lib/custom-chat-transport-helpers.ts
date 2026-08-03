import type { UIMessage } from '@ai-sdk/react'
import { jsonSchema, type Tool } from 'ai'

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
