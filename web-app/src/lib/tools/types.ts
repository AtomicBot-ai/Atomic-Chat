import { ToolUIPart } from 'ai'
import type { AgentRunSummary } from '@/types/agent'
import type { ChatExecToolOutput } from '@/lib/chat-exec-tools'

export type ToolPresentation =
  | {
      kind: 'generic'
      title: string
      subtitle?: string
      input?: unknown
      output?: unknown
      errorText?: string
      deniedReason?: string
    }
  | {
      kind: 'web_search_exa'
      title: string
      subtitle?: string
      query?: string
      results: Array<{
        title: string
        url?: string
        domain?: string
        author?: string
        published?: string
        highlights: string[]
      }>
      rawInput?: unknown
      rawOutput?: unknown
      errorText?: string
    }
  | {
      kind: 'web_fetch_exa'
      title: string
      subtitle?: string
      urls?: string[]
      pages: Array<{
        title: string
        url?: string
        domain?: string
        author?: string
        published?: string
        highlights: string[]
      }>
      rawInput?: unknown
      rawOutput?: unknown
      errorText?: string
    }
  | {
      /** Chat's own `run_command` / `run_script` (lib/chat-exec-tools). */
      kind: 'chat_exec'
      title: string
      subtitle?: string
      /** Display name of a script's language; absent for a command. */
      language?: string
      /** The command line or the script. */
      source?: string
      output?: ChatExecToolOutput
      errorText?: string
      /** Ran, but did not succeed: non-zero exit, timeout or Stop. */
      failed: boolean
    }

export type TraceBlock =
  | { kind: 'text'; key: string; text: string }
  | {
      kind: 'file'
      key: string
      url: string
      mediaType: string
      filename?: string
    }
  | {
      kind: 'audio'
      key: string
      url: string
      mediaType: string
      filename?: string
    }
  | {
      kind: 'reasoning'
      key: string
      streaming: boolean
      items: Array<{ key: string; text: string }>
    }
  | {
      kind: 'activity'
      key: string
      durationMs?: number
      tools: Array<{
        key: string
        toolName: string
        state: ToolUIPart['state']
        presentation: ToolPresentation
      }>
      agentSummary?: AgentRunSummary
    }

export type ParsedSearchItem = {
  title?: string
  url?: string
  published?: string
  author?: string
  highlights?: string[]
}
