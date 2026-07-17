import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAgentRunState,
  reduceAgentRunState,
  useAgentRun,
} from '@/hooks/useAgentRun'
import type { AgentEvent } from '@/types/agent'

const parsed: AgentEvent = {
  type: 'tool_call_parsed',
  call: { tool: 'os.fs.read', args: { path: '/tmp/a' } },
  batch_index: 0,
  batch_size: 1,
}

describe('useAgentRun', () => {
  beforeEach(() => {
    useAgentRun.getState().clearAll()
  })

  it('keeps run state isolated by thread', () => {
    useAgentRun.getState().startRun('thread-a', 'run-a')
    useAgentRun.getState().startRun('thread-b', 'run-b')
    useAgentRun.getState().applyEvent('thread-a', parsed)

    expect(useAgentRun.getState().getRun('thread-a').trace.tools).toHaveLength(
      1
    )
    expect(useAgentRun.getState().getRun('thread-b').trace.tools).toHaveLength(
      0
    )
  })

  it('replaces a parsed call with its executed result', () => {
    const parsedState = reduceAgentRunState(createAgentRunState(), parsed)
    const executedState = reduceAgentRunState(parsedState, {
      type: 'tool_call_executed',
      result: {
        call: parsed.call,
        outcome: { status: 'ok', summary: 'Read file' },
        batch_index: 0,
        batch_size: 1,
      },
    })

    expect(executedState.trace.tools).toEqual([
      {
        call: parsed.call,
        outcome: { status: 'ok', summary: 'Read file' },
        batchIndex: 0,
        batchSize: 1,
      },
    ])
  })

  it('clears a pending approval on execution, error, and terminal events', () => {
    const approval: AgentEvent = {
      type: 'approval_requested',
      run_id: 'run-a',
      approval_id: 'approval-a',
      tool: 'os.fs.write',
      reason: 'Filesystem write',
      preview: { path: '/tmp/a' },
      affected_resources: [],
    }
    const awaiting = reduceAgentRunState(createAgentRunState(), approval)
    expect(awaiting.status).toBe('awaiting_approval')

    const executed = reduceAgentRunState(awaiting, {
      type: 'tool_call_executed',
      result: {
        call: parsed.call,
        outcome: { status: 'denied', summary: 'Denied' },
        batch_index: 0,
        batch_size: 1,
      },
    })
    expect(executed.pendingApproval).toBeUndefined()

    const errored = reduceAgentRunState(awaiting, {
      type: 'step_error',
      category: 'tool',
      message: 'Denied',
    })
    expect(errored.pendingApproval).toBeUndefined()
    expect(errored.status).toBe('failed')

    const finished = reduceAgentRunState(awaiting, {
      type: 'turn_finished',
      reason: 'cancelled',
      step_count: 1,
    })
    expect(finished.pendingApproval).toBeUndefined()
    expect(finished.status).toBe('cancelled')
  })
})
