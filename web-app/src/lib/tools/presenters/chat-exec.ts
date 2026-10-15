import {
  chatExecLanguageName,
  isChatExecToolOutput,
  RUN_COMMAND_TOOL,
} from '@/lib/chat-exec-tools'
import type { ToolPresentation } from '../types'

export function presentChatExec(args: {
  toolName: string
  input?: unknown
  output?: unknown
  errorText?: string
}): ToolPresentation {
  const input =
    args.input && typeof args.input === 'object'
      ? (args.input as Record<string, unknown>)
      : {}
  const isCommand = args.toolName === RUN_COMMAND_TOOL
  const source = isCommand ? input.command : input.code
  const output = isChatExecToolOutput(args.output) ? args.output : undefined
  const language = isCommand ? undefined : chatExecLanguageName(input.language)
  return {
    kind: 'chat_exec',
    title: isCommand ? 'Command' : `${language ?? 'Script'} script`,
    subtitle: typeof source === 'string' ? source.split('\n')[0] : undefined,
    language,
    source: typeof source === 'string' ? source : undefined,
    output,
    errorText: args.errorText,
    failed: Boolean(
      output && (output.cancelled || output.timedOut || output.exitCode !== 0)
    ),
  }
}
