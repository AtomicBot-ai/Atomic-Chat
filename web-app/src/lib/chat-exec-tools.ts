import type { UIMessage } from '@ai-sdk/react'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import {
  refreshChatExecStatus,
  useChatExecStatus,
} from '@/hooks/useChatExecStatus'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import type {
  ChatExecLanguage,
  ChatExecRequest,
  ChatExecResult,
  ChatExecSandboxKind,
  ChatExecService,
  ChatExecStatus,
  ChatExecUserFolder,
} from '@/services/chat-exec/types'
import type { MCPTool } from '@/types/completion'

/**
 * Built-in chat tools that run a terminal command or a script on the user's
 * computer (`src-tauri/src/core/chat_exec`). They ride next to the MCP tools
 * in every chat request while the composer's "Run commands" item is on, and
 * each call goes through the thread's approval mode first (lib/mcp-approval).
 */
export const RUN_COMMAND_TOOL = 'run_command'
export const RUN_SCRIPT_TOOL = 'run_script'
const CHAT_EXEC_TOOLS: ReadonlySet<string> = new Set([
  RUN_COMMAND_TOOL,
  RUN_SCRIPT_TOOL,
])
/** The `server` the two tools carry in the MCP-shaped tool list. */
export const CHAT_EXEC_SERVER = 'atomic-chat'

export const DEFAULT_TIMEOUT_SECONDS = 120
export const MAX_TIMEOUT_SECONDS = 600

export function isChatExecTool(toolName: string): boolean {
  return CHAT_EXEC_TOOLS.has(toolName)
}

const LANGUAGE_NAMES: Record<ChatExecLanguage, string> = {
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  shell: 'shell',
  powershell: 'PowerShell',
  ruby: 'Ruby',
  perl: 'Perl',
  php: 'PHP',
  lua: 'Lua',
  r: 'R',
}

export function chatExecLanguageName(language: unknown): string | undefined {
  return typeof language === 'string' && language in LANGUAGE_NAMES
    ? LANGUAGE_NAMES[language as ChatExecLanguage]
    : undefined
}

/** Whether chat requests carry the tools right now. */
export function isChatExecOffered(
  status: ChatExecStatus | null = useChatExecStatus.getState().status
): boolean {
  return (
    Boolean(PlatformFeatures[PlatformFeature.CHAT_EXEC]) &&
    useGeneralSetting.getState().chatExecEnabled &&
    Boolean(status?.supported)
  )
}

/** The names a tool call is routed to `chatExec` by (empty while not offered). */
export function offeredChatExecToolNames(): ReadonlySet<string> {
  return isChatExecOffered() ? CHAT_EXEC_TOOLS : new Set()
}

const USER_FOLDER_NAMES: Record<ChatExecUserFolder['kind'], string> = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
}

/**
 * Where a call runs and where the user's files are. Without the folders a
 * model asked about "my desktop" looks in the scratch folder, finds nothing
 * and reports it as the user's desktop.
 */
function placeSentence(status: ChatExecStatus): string {
  const sentences = [
    "The working directory is a scratch folder of this chat (its files stay between calls), not the user's home: a relative path such as Desktop/notes.txt lands in it.",
  ]
  if (status.userFolders.length > 0) {
    const folders = status.userFolders
      .map((folder) => `${USER_FOLDER_NAMES[folder.kind]}: ${folder.path}`)
      .join('; ')
    const quoting =
      status.os !== 'windows' &&
      status.userFolders.some((folder) => folder.path.includes(' '))
        ? ' (~ is $HOME; inside quotes write "$HOME/…")'
        : ''
    sentences.push(
      `The user's own folders are ${folders}${quoting}. When the user asks about their files, use these paths.`
    )
  }
  if (status.os === 'windows') {
    sentences.push(
      status.sandbox.kind === 'mxc'
        ? 'It runs in a Windows sandbox: only the chat folder and those user folders can be reached; the rest of the computer cannot be read or written.'
        : "It runs directly on the user's Windows computer."
    )
  }
  return sentences.join(' ')
}

const TIMEOUT_SENTENCE = `It is stopped after timeout_seconds (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}); interactive programs, servers and anything that waits for input will not work.`

function timeoutProperty() {
  return {
    type: 'integer',
    description: `Seconds before the run is stopped (default ${DEFAULT_TIMEOUT_SECONDS}, at most ${MAX_TIMEOUT_SECONDS}).`,
    minimum: 1,
    maximum: MAX_TIMEOUT_SECONDS,
  }
}

/** `run_command` and `run_script`, described for this machine. */
export function chatExecTools(status: ChatExecStatus): MCPTool[] {
  if (!status.supported) return []
  const shell =
    status.shell === 'cmd'
      ? 'The command runs in Windows cmd.exe, not bash: use Windows commands (dir, type, copy, where), one line, and join steps with &&.'
      : 'The command runs in sh, like a terminal.'
  const tools: MCPTool[] = [
    {
      name: RUN_COMMAND_TOOL,
      server: CHAT_EXEC_SERVER,
      description: [
        "Run a terminal command on the user's computer and get its output and exit code.",
        shell,
        placeSentence(status),
        "`python -m pip install <package>` installs Python packages into this chat, where run_script's Python finds them.",
        TIMEOUT_SENTENCE,
        'The user approves each call.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The command line to run.',
          },
          timeout_seconds: timeoutProperty(),
        },
        required: ['command'],
      },
    },
  ]
  if (status.languages.length > 0) {
    tools.push({
      name: RUN_SCRIPT_TOOL,
      server: CHAT_EXEC_SERVER,
      description: [
        'Run a complete script and get its output and exit code.',
        `Languages available here: ${status.languages.map((language) => LANGUAGE_NAMES[language]).join(', ')}.`,
        'Print what you need to see; nothing is returned implicitly.',
        placeSentence(status),
        'Files the script writes stay in that folder.',
        TIMEOUT_SENTENCE,
        'The user approves each call.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: status.languages,
            description: 'The language the code is written in.',
          },
          code: {
            type: 'string',
            description: 'The whole script.',
          },
          timeout_seconds: timeoutProperty(),
        },
        required: ['language', 'code'],
      },
    })
  }
  return tools
}

/** The backend request for one tool call, or why the call is malformed. */
export function toChatExecRequest(
  toolName: string,
  input: unknown,
  callId: string,
  threadId: string
): { request: ChatExecRequest } | { error: string } {
  const args =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const timeout = args.timeout_seconds
  const timeoutSeconds =
    typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? Math.min(Math.round(timeout), MAX_TIMEOUT_SECONDS)
      : undefined
  if (toolName === RUN_COMMAND_TOOL) {
    if (typeof args.command !== 'string' || !args.command.trim()) {
      return { error: '`command` must be a non-empty string' }
    }
    return {
      request: {
        callId,
        threadId,
        kind: 'command',
        source: args.command,
        timeoutSeconds,
      },
    }
  }
  if (typeof args.code !== 'string' || !args.code.trim()) {
    return { error: '`code` must be a non-empty string' }
  }
  if (typeof args.language !== 'string' || !(args.language in LANGUAGE_NAMES)) {
    return {
      error: `\`language\` must be one of: ${Object.keys(LANGUAGE_NAMES).join(', ')}`,
    }
  }
  return {
    request: {
      callId,
      threadId,
      kind: 'script',
      language: args.language as ChatExecLanguage,
      source: args.code,
      timeoutSeconds,
    },
  }
}

/**
 * What a finished call keeps in the message: `text` is what the model reads
 * (see `chatExecOutputsForModel`), the rest is for the tool row.
 */
export type ChatExecToolOutput = {
  kind: 'chat-exec'
  text: string
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  sandbox: ChatExecSandboxKind
  workdir: string
  durationMs: number
}

export function isChatExecToolOutput(
  value: unknown
): value is ChatExecToolOutput {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'chat-exec' &&
    typeof (value as { text?: unknown }).text === 'string'
  )
}

export function chatExecResultText(result: ChatExecResult): string {
  const sections: string[] = []
  if (result.cancelled) {
    sections.push('Stopped by the user before it finished.')
  } else if (result.timedOut) {
    sections.push('Timed out and was stopped.')
  } else {
    sections.push(`Exit code: ${result.exitCode ?? 'none'}`)
  }
  const stdout = result.stdout.trimEnd()
  const stderr = result.stderr.trimEnd()
  if (stdout) sections.push(`stdout:\n${stdout}`)
  if (stderr) sections.push(`stderr:\n${stderr}`)
  if (!stdout && !stderr) sections.push('(no output)')
  if (result.truncated) {
    sections.push('(The middle of a long output was left out.)')
  }
  if (result.hint) sections.push(`Note: ${result.hint}`)
  return sections.join('\n\n')
}

export function toChatExecToolOutput(
  result: ChatExecResult
): ChatExecToolOutput {
  return {
    kind: 'chat-exec',
    text: chatExecResultText(result),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    sandbox: result.sandbox,
    workdir: result.workdir,
    durationMs: result.durationMs,
  }
}

/**
 * The model reads a run's text, not the object the tool row is drawn from.
 * Applied right before the messages are converted for the model.
 */
export function chatExecOutputsForModel(messages: UIMessage[]): UIMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) {
      return message
    }
    let partsChanged = false
    const parts = message.parts.map((part) => {
      if (
        !part.type.startsWith('tool-') ||
        !isChatExecTool(part.type.slice('tool-'.length)) ||
        !('output' in part) ||
        !isChatExecToolOutput(part.output)
      ) {
        return part
      }
      partsChanged = true
      return { ...part, output: part.output.text }
    })
    if (!partsChanged) return message
    changed = true
    return { ...message, parts } as UIMessage
  })
  return changed ? next : messages
}

/**
 * Run one approved call. Aborting `signal` (the user pressed Stop) stops the
 * process; the call still reports what it printed until then.
 */
export async function runChatExecToolCall({
  service,
  toolCallId,
  toolName,
  input,
  threadId,
  signal,
}: {
  service: ChatExecService
  toolCallId: string
  toolName: string
  input: unknown
  threadId: string
  signal: AbortSignal
}): Promise<{ output: ChatExecToolOutput } | { error: string }> {
  const parsed = toChatExecRequest(toolName, input, toolCallId, threadId)
  if ('error' in parsed) return parsed
  if (signal.aborted) return { error: 'Stopped before it started' }
  const stop = () => {
    void service.cancel(toolCallId).catch(() => undefined)
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    const result = await service.run(parsed.request)
    return { output: toChatExecToolOutput(result) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    signal.removeEventListener('abort', stop)
    // A sandbox that failed to start is dropped for the session; the next
    // approval has to say so.
    void refreshChatExecStatus()
  }
}
