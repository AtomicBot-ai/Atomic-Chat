import type { AgentReasoningRequest } from '@/lib/reasoning-effort'

export type AgentToolStatus = 'ok' | 'error' | 'denied' | 'cancelled'

export type AgentLoopLevel = 'warn' | 'critical' | 'breaker'

export type AgentLoopDetector = 'generic_repeat' | 'no_progress' | 'wandering'

export type AgentTurnFinishReason =
  | 'reply'
  | 'finish'
  | 'max_steps'
  | 'cancelled'
  | 'failed'

export type AgentAttachment = {
  kind: 'file' | 'image'
  name: string
  media_type?: string
  path?: string
  data_url?: string
}

export type AgentTurnRequest = {
  run_id: string
  session_id: string
  model_id: string
  /**
   * Selected provider. Omitting it keeps the legacy behaviour of scanning both
   * llama.cpp session maps.
   */
  provider?: string
  /**
   * Model capabilities (`tools`, `vision`, …). The backend has no `mmproj` to
   * inspect for MLX or cloud models, so this is where vision support comes
   * from.
   */
  capabilities?: string[]
  /** Context window, when known. Falls back to the configured cap. */
  context_window?: number
  user_message: string
  selected_skill?: string
  attachments?: AgentAttachment[]
  working_dir?: string
  external_roots?: Array<{ path: string; can_edit: boolean }>
  max_steps?: number
  auto_approve: boolean
  /**
   * Thinking intent for this turn, resolved from the global reasoning
   * setting and the model's declared controls. Omitting it leaves the
   * backend's default, which is to request no thinking.
   */
  reasoning?: AgentReasoningRequest
  /**
   * The thread assistant's system prompt, already rendered
   * (`renderInstructions` resolved `{{current_date}}` etc.). The backend
   * appends it as the final stable-prefix section.
   */
  assistant_instructions?: string
  /** Assistant sampling bag; applied only when `sampling_overridden`. */
  sampling?: AgentSamplingRequest
  sampling_overridden?: boolean
  /** Built-in web tools on/off for this turn. Defaults to on. */
  web_search?: boolean
  /** Expose connected MCP servers as dynamic agent tools. Defaults to on. */
  mcp_enabled?: boolean
  /**
   * Auto-approve MCP-origin tools (the migrated chat auto-approve setting).
   * Never widens approval for built-in shell/fs tools.
   */
  auto_approve_mcp?: boolean
  /** Per-thread disabled MCP tools as `server::tool` keys. */
  disabled_mcp_tools?: string[]
  /**
   * Document-index (RAG) context for this turn. Omitting it disables the
   * agent's `docs.*` tools. Collection names are final vector-db names
   * (see `@/lib/rag-collections`) and reach the backend verbatim.
   */
  rag?: AgentRagRequest
}

export type AgentRagRequest = {
  thread_collection: string
  project_collection?: string
  /** Names of documents indexed on this turn, for the model-visible note. */
  attached_file_names: string[]
}

export type AgentSamplingRequest = {
  temperature?: number
  top_p?: number
  top_k?: number
  min_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  repeat_penalty?: number
}

/** Aggregated model usage reported by `turn_finished`. */
export type AgentTurnUsage = {
  tokens_in: number
  tokens_out: number
  tps?: number
  ttft_ms?: number
}

export type AgentReseedMessage = {
  role: 'user' | 'assistant'
  text: string
}

export type AgentWorkspaceRequest = {
  workingDir?: string
  rootId?: string
  rootPath?: string
  relativePath?: string
  path?: string
  maxBytes?: number
}

export type AgentWorkspaceRoot = {
  rootId: string
  path: string
  name: string
}

export type AgentWorkspaceEntry = {
  name: string
  path: string
  kind: 'directory' | 'file' | 'unknown'
  size?: number
  modifiedMs?: number
}

export type AgentWorkspaceFile = {
  path: string
  absolutePath: string
  size: number
  modifiedMs?: number
  extension: string
}

export type AgentWorkspaceText = {
  path: string
  content: string
  truncated: boolean
}

export type AgentApprovalResolution = 'deny' | 'allow_once' | 'always_allow'

export type AgentApprovalDecision = {
  approval_id: string
  decision: AgentApprovalResolution
}

export type AgentFolderAccessDecision = {
  run_id: string
  access_id: string
  allow: boolean
}

export type AgentApprovalResource = {
  kind: string
  value: string
  operation: string
}

export type AgentToolCall = {
  tool: string
  args: unknown
}

export type AgentToolOutcome = {
  status: AgentToolStatus
  summary: string
  details?: unknown
}

export type AgentToolExecution = {
  call: AgentToolCall
  outcome: AgentToolOutcome
  batch_index: number
  batch_size: number
}

export type AgentEvent =
  | { type: 'turn_started'; run_id: string; session_id: string }
  | { type: 'step_started'; step_index: number }
  | { type: 'reasoning_delta'; step_index: number; text: string }
  | { type: 'assistant_delta'; text: string }
  | {
      type: 'tool_call_parsed'
      call: AgentToolCall
      batch_index: number
      batch_size: number
    }
  | { type: 'tool_call_executed'; result: AgentToolExecution }
  | {
      type: 'approval_requested'
      run_id: string
      approval_id: string
      tool: string
      reason: string
      preview: unknown
      affected_resources: AgentApprovalResource[]
      can_remember: boolean
    }
  | {
      type: 'folder_access_requested'
      run_id: string
      access_id: string
      tool: string
      path: string
      display_name: string
      root_id: string
      reason: string
    }
  | {
      type: 'loop_detected'
      level: AgentLoopLevel
      detector: AgentLoopDetector
      message: string
    }
  | { type: 'parse_retry'; step_index: number; reason: string }
  | {
      type: 'batch_trimmed'
      step_index: number
      reason: string
      kept_tool: string
      dropped_tools: string[]
    }
  | { type: 'assistant_reply'; text: string }
  | { type: 'step_error'; message: string; category: string }
  | {
      type: 'turn_finished'
      reason: AgentTurnFinishReason
      step_count: number
      usage?: AgentTurnUsage
    }

export type AgentApprovalRequestEvent = Extract<
  AgentEvent,
  { type: 'approval_requested' }
>

export type AgentFolderAccessRequestEvent = Extract<
  AgentEvent,
  { type: 'folder_access_requested' }
>

export type AgentRunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_folder_access'
  | 'finished'
  | 'failed'
  | 'cancelled'

export type AgentRunToolTrace = {
  call: AgentToolCall
  outcome?: AgentToolOutcome
  batchIndex: number
  batchSize: number
}

export type AgentRunLoopTrace = {
  level: AgentLoopLevel
  detector: AgentLoopDetector
  message: string
}

export type AgentRunError = {
  category: string
  message: string
}

export type AgentRunTrace = {
  reasoning: Record<number, string>
  assistantText: string
  tools: AgentRunToolTrace[]
  loops: AgentRunLoopTrace[]
  error?: AgentRunError
  finishReason?: AgentTurnFinishReason
  stepCount?: number
}

export type AgentRunState = {
  runId?: string
  startedAtMs?: number
  finishedAtMs?: number
  usage?: AgentTurnUsage
  status: AgentRunStatus
  pendingApproval?: AgentApprovalRequestEvent
  pendingFolderAccess?: AgentFolderAccessRequestEvent
  approvalResolving: boolean
  folderAccessResolving: boolean
  trace: AgentRunTrace
}

export type AgentRunSummary = {
  run_id: string
  status: AgentRunStatus
  finish_reason?: AgentTurnFinishReason
  step_count?: number
  duration_ms?: number
  tools: Array<{
    tool: string
    status?: AgentToolStatus
    batch_index: number
    batch_size: number
  }>
  loops: AgentRunLoopTrace[]
  error?: AgentRunError
}
