/**
 * Terminal commands and scripts the chat's model runs (`run_command` /
 * `run_script`). Mirrors `src-tauri/src/core/chat_exec/types.rs`.
 */

export type ChatExecKind = 'command' | 'script'

export type ChatExecLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'shell'
  | 'powershell'
  | 'ruby'
  | 'perl'
  | 'php'
  | 'lua'
  | 'r'

/** `mxc`: inside Microsoft MXC on Windows. `none`: on the host, as the user. */
export type ChatExecSandboxKind = 'mxc' | 'none'

/** One of the user's own folders: `~/…` on macOS/Linux, absolute on Windows. */
export type ChatExecUserFolder = {
  kind: 'desktop' | 'documents' | 'downloads'
  path: string
}

export type ChatExecStatus = {
  supported: boolean
  os: 'macos' | 'windows' | 'linux'
  /** What `run_command` goes through. */
  shell: 'sh' | 'cmd'
  /** The `run_script` languages this machine can run. */
  languages: ChatExecLanguage[]
  sandbox: {
    kind: ChatExecSandboxKind
    /** Why there is no sandbox where one was expected (Windows). */
    reason: string | null
  }
  /** The user's Desktop, Documents and Downloads, where they exist. */
  userFolders: ChatExecUserFolder[]
}

export type ChatExecRequest = {
  callId: string
  threadId: string
  kind: ChatExecKind
  language?: ChatExecLanguage
  source: string
  timeoutSeconds?: number
}

export type ChatExecResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  cancelled: boolean
  sandbox: ChatExecSandboxKind
  /** The chat's folder the call ran in. */
  workdir: string
  durationMs: number
  /** A refusal the OS made, explained for the model (macOS privacy, the Windows sandbox). */
  hint?: string | null
}

export const UNSUPPORTED_CHAT_EXEC_STATUS: ChatExecStatus = {
  supported: false,
  os: 'linux',
  shell: 'sh',
  languages: [],
  sandbox: { kind: 'none', reason: null },
  userFolders: [],
}

export interface ChatExecService {
  status(): Promise<ChatExecStatus>
  run(request: ChatExecRequest): Promise<ChatExecResult>
  /** `false` when the call is not running (any more). */
  cancel(callId: string): Promise<boolean>
}
