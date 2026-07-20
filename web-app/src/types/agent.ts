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
  user_message: string
  attachments?: AgentAttachment[]
  working_dir?: string
  max_steps?: number
  auto_approve: boolean
}

export type AgentApprovalDecision = {
  approval_id: string
  approved: boolean
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
    }

export type AgentApprovalRequestEvent = Extract<
  AgentEvent,
  { type: 'approval_requested' }
>

export type AgentRunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
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
  status: AgentRunStatus
  pendingApproval?: AgentApprovalRequestEvent
  approvalResolving: boolean
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
