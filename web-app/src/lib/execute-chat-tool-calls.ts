import type { UIMessage } from '@ai-sdk/react'
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai'

export type ChatToolCall = {
  toolCallId: string
  toolName: string
  input: object
}

export type ChatToolOutput =
  | {
      tool: string
      toolCallId: string
      output: unknown
    }
  | {
      state: 'output-error'
      tool: string
      toolCallId: string
      errorText: string
    }

type ToolResult = {
  content?: unknown
  error?: unknown
}

type ExecuteChatToolCallsOptions = {
  toolCalls: readonly ChatToolCall[]
  signal: AbortSignal
  threadId: string
  ragToolNames: ReadonlySet<string>
  mcpToolNames: ReadonlySet<string>
  approve: (
    toolName: string,
    threadId: string,
    input: object
  ) => Promise<boolean>
  callRagTool: (args: {
    toolName: string
    arguments: object
    threadId: string
    projectId?: string
    scope: 'project' | 'thread'
  }) => Promise<ToolResult>
  callMcpTool: (args: {
    toolName: string
    arguments: object
  }) => Promise<ToolResult>
  getProjectId: () => string | undefined
  processOutput: (content: unknown) => Promise<unknown>
  addToolOutput: (output: ChatToolOutput) => void
  onError?: (error: unknown) => void
}

export async function executeChatToolCalls({
  toolCalls,
  signal,
  threadId,
  ragToolNames,
  mcpToolNames,
  approve,
  callRagTool,
  callMcpTool,
  getProjectId,
  processOutput,
  addToolOutput,
  onError = (error) => console.error('Tool call error:', error),
}: ExecuteChatToolCallsOptions): Promise<void> {
  for (const toolCall of toolCalls) {
    if (signal.aborted) break

    try {
      const approved = await approve(
        toolCall.toolName,
        threadId,
        toolCall.input
      )

      if (!approved) {
        addToolOutput({
          state: 'output-error',
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: 'Tool execution denied by user',
        })
        continue
      }

      let result: ToolResult
      if (ragToolNames.has(toolCall.toolName)) {
        const projectId = getProjectId()
        result = await callRagTool({
          toolName: toolCall.toolName,
          arguments: toolCall.input,
          threadId,
          projectId,
          scope: projectId ? 'project' : 'thread',
        })
      } else if (mcpToolNames.has(toolCall.toolName)) {
        result = await callMcpTool({
          toolName: toolCall.toolName,
          arguments: toolCall.input,
        })
      } else {
        result = {
          error: `Tool '${toolCall.toolName}' not found in any service`,
        }
      }

      if (result.error) {
        addToolOutput({
          state: 'output-error',
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: `Error: ${result.error}`,
        })
      } else {
        addToolOutput({
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          output: await processOutput(result.content),
        })
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        onError(error)
        addToolOutput({
          state: 'output-error',
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: `Error: ${JSON.stringify(error)}`,
        })
      }
    }
  }
}

export function shouldSendToolFollowUp(
  messages: UIMessage[],
  controller: AbortController | null
): boolean {
  if (!controller || controller.signal.aborted) return false
  return lastAssistantMessageIsCompleteWithToolCalls({ messages })
}
