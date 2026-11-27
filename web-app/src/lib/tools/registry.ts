import type { ToolPresentation } from './types'
import { presentWebFetchExa } from './presenters/web-fetch-exa'
import { presentWebSearchExa } from './presenters/web-search-exa'
import { presentGenericTool } from './presenters/generic'
import { presentChatExec } from './presenters/chat-exec'
import { RUN_COMMAND_TOOL, RUN_SCRIPT_TOOL } from '@/lib/chat-exec-tools'

type PresenterArgs = {
  toolName: string
  input?: unknown
  output?: unknown
  errorText?: string
  state: string
}

type ToolPresenter = (args: PresenterArgs) => ToolPresentation

function presentPiTool(args: PresenterArgs): ToolPresentation {
  const input = (args.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === 'string' ? input.path : undefined
  if (args.toolName === 'bash' || args.toolName === 'powershell') {
    const source = typeof input.command === 'string' ? input.command : ''
    return {
      kind: 'chat_exec',
      title: args.toolName,
      subtitle: source.split('\n')[0],
      source,
      liveOutput: typeof args.output === 'string' ? args.output : undefined,
      errorText: args.errorText,
      failed: Boolean(args.errorText),
    }
  }
  if (args.toolName === 'read')
    return { ...presentGenericTool(args), title: 'read', subtitle: path }
  const edits = Array.isArray(input.edits) ? input.edits : [input]
  type Line = { kind: 'add' | 'remove'; text: string }
  const lines: Line[] = []
  for (const entry of edits) {
    if (!entry || typeof entry !== 'object') continue
    const segments = [
      ['remove', entry.oldText],
      ['add', entry.newText ?? entry.content],
    ] as const
    for (const [kind, value] of segments) {
      if (typeof value !== 'string') continue
      for (const text of value.split('\n', 501 - lines.length)) {
        if (lines.length === 500) {
          lines.push({ kind, text: '…' })
          break
        }
        lines.push({ kind, text })
      }
      if (lines.length > 500) break
    }
    if (lines.length > 500) break
  }
  return {
    kind: 'pi_file',
    title: args.toolName,
    subtitle: path,
    lines,
    errorText: args.errorText,
  }
}

const presenters: Record<string, ToolPresenter> = {
  web_search_exa: presentWebSearchExa,
  web_fetch_exa: presentWebFetchExa,
  bash: presentPiTool,
  powershell: presentPiTool,
  read: presentPiTool,
  edit: presentPiTool,
  write: presentPiTool,
  [RUN_COMMAND_TOOL]: presentChatExec,
  [RUN_SCRIPT_TOOL]: presentChatExec,
}

export function presentTool(args: PresenterArgs): ToolPresentation {
  const presenter = presenters[args.toolName]
  if (presenter) return presenter(args)
  return presentGenericTool(args)
}
