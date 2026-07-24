import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentRunState,
  reduceAgentRunState,
  useAgentRun,
} from '@/hooks/useAgentRun'
import type { AgentEvent } from '@/types/agent'
import { runAgentTurn } from '@/services/agent/tauri'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((event: AgentEvent) => void) | undefined
  },
}))

const parsed: AgentEvent = {
  type: 'tool_call_parsed',
  call: { tool: 'os.fs.read', args: { path: '/tmp/a' } },
  batch_index: 0,
  batch_size: 1,
}

describe('useAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('tracks the full agent run duration from start to terminal event', () => {
    const running = reduceAgentRunState(
      createAgentRunState(),
      {
        type: 'turn_started',
        run_id: 'run-a',
        session_id: 'thread-a',
      },
      1_000
    )
    const finished = reduceAgentRunState(
      running,
      {
        type: 'turn_finished',
        reason: 'reply',
        step_count: 2,
      },
      4_250
    )

    expect(finished.startedAtMs).toBe(1_000)
    expect(finished.finishedAtMs).toBe(4_250)
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
      can_remember: true,
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

  it('tracks folder access separately from ordinary approvals', () => {
    const awaiting = reduceAgentRunState(createAgentRunState(), {
      type: 'folder_access_requested',
      run_id: 'run-a',
      access_id: 'access-a',
      tool: 'os.fs.write',
      path: '/Users/test/Desktop',
      display_name: 'Desktop',
      root_id: 'desktop-root',
      reason: 'Folder access is required',
    })

    expect(awaiting.status).toBe('awaiting_folder_access')
    expect(awaiting.pendingFolderAccess).toEqual({
      type: 'folder_access_requested',
      run_id: 'run-a',
      access_id: 'access-a',
      tool: 'os.fs.write',
      path: '/Users/test/Desktop',
      display_name: 'Desktop',
      root_id: 'desktop-root',
      reason: 'Folder access is required',
    })
    expect(awaiting.pendingApproval).toBeUndefined()

    const finished = reduceAgentRunState(awaiting, {
      type: 'turn_finished',
      reason: 'cancelled',
      step_count: 1,
    })
    expect(finished.pendingFolderAccess).toBeUndefined()
    expect(finished.status).toBe('cancelled')
  })

  it('forwards the thread-bound session id to the agent command', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    const request = {
      run_id: 'run-a',
      session_id: 'thread-a',
      model_id: 'model-a',
      user_message: 'continue',
      working_dir: '/tmp',
      auto_approve: false,
    }

    await runAgentTurn(request, () => undefined)

    expect(invoke).toHaveBeenCalledWith('agent_run_turn', {
      request,
      onEvent: expect.anything(),
    })
  })

  it('accepts recovery diagnostics without changing run lifecycle state', () => {
    const running = reduceAgentRunState(createAgentRunState(), {
      type: 'turn_started',
      run_id: 'run-a',
      session_id: 'thread-a',
    })
    const afterRetry = reduceAgentRunState(running, {
      type: 'parse_retry',
      step_index: 1,
      reason: 'invalid terminal position',
    })
    const afterTrim = reduceAgentRunState(afterRetry, {
      type: 'batch_trimmed',
      step_index: 1,
      reason: 'approval-gated tools must run solo',
      kept_tool: 'os.fs.write',
      dropped_tools: ['os.fs.edit'],
    })

    expect(afterRetry).toBe(running)
    expect(afterTrim).toBe(running)
    expect(afterTrim.status).toBe('running')
    expect(afterTrim.trace.tools).toEqual([])
  })
})
