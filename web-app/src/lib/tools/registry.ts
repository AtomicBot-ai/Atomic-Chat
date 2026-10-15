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

const presenters: Record<string, ToolPresenter> = {
  web_search_exa: presentWebSearchExa,
  web_fetch_exa: presentWebFetchExa,
  [RUN_COMMAND_TOOL]: presentChatExec,
  [RUN_SCRIPT_TOOL]: presentChatExec,
}

export function presentTool(args: PresenterArgs): ToolPresentation {
  const presenter = presenters[args.toolName]
  if (presenter) return presenter(args)
  return presentGenericTool(args)
}
