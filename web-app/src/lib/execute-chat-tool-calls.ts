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
  /**
   * `run_command` / `run_script` while chat offers them. Checked first: the
   * built-in tools win a name clash with an MCP tool.
   */
  execToolNames?: ReadonlySet<string>
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
  /** `threadId` lets the backend refuse servers a secure project does not allow. */
  callMcpTool: (args: {
    toolName: string
    arguments: object
    threadId: string
  }) => Promise<ToolResult>
  /** Runs an approved command/script; stops it when `signal` aborts. */
  callExecTool?: (args: {
    toolCallId: string
    toolName: string
    input: object
    threadId: string
    signal: AbortSignal
  }) => Promise<{ output: unknown } | { error: string }>
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
  execToolNames = new Set(),
  approve,
  callRagTool,
  callMcpTool,
  callExecTool,
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

      if (execToolNames.has(toolCall.toolName) && callExecTool) {
        const run = await callExecTool({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          threadId,
          signal,
        })
        addToolOutput(
          'error' in run
            ? {
                state: 'output-error',
                tool: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                errorText: `Error: ${run.error}`,
              }
            : {
                tool: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                output: run.output,
              }
        )
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
          threadId,
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

/**
 * True when the message still contains tool calls waiting on their results,
 * i.e. the turn will continue once they resolve. Tool parts with a delivered
 * output (`output-available` / `output-error`) count as resolved — a final
 * answer that follows answered tool calls is still terminal.
 */
export function hasUnresolvedToolCallParts(message: UIMessage): boolean {
  return message.parts.some((part) => {
    const isToolPart =
      part.type.startsWith('tool-') || part.type === 'dynamic-tool'
    if (!isToolPart) return false
    const state = (part as { state?: string }).state
    return state !== 'output-available' && state !== 'output-error'
  })
}

export function shouldSendToolFollowUp(
  messages: UIMessage[],
  controller: AbortController | null
): boolean {
  if (!controller || controller.signal.aborted) return false
  return lastAssistantMessageIsCompleteWithToolCalls({ messages })
}
