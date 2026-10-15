import { describe, expect, it } from 'vitest'
import { presentTool } from '../../registry'
import { toolActivityLabel } from '../../activity-label'

const t = (key: string, params?: Record<string, unknown>) =>
  params?.target ? `${key}(${String(params.target)})` : key

const output = (overrides: Record<string, unknown> = {}) => ({
  kind: 'chat-exec',
  text: 'Exit code: 0',
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  sandbox: 'none',
  workdir: '/w',
  durationMs: 5,
  ...overrides,
})

describe('chat command and script rows', () => {
  it('labels a finished command as a shell action', () => {
    const presentation = presentTool({
      toolName: 'run_command',
      input: { command: 'ls -la\necho more' },
      output: output(),
      state: 'output-available',
    })

    expect(presentation).toMatchObject({
      kind: 'chat_exec',
      source: 'ls -la\necho more',
      subtitle: 'ls -la',
      failed: false,
    })
    expect(
      toolActivityLabel('run_command', presentation, 'output-available', t)
    ).toBe('toolCall.actions.shell.success')
  })

  it('names the script language and marks a non-zero exit as failed', () => {
    const presentation = presentTool({
      toolName: 'run_script',
      input: { language: 'python', code: 'raise SystemExit(1)' },
      output: output({ exitCode: 1 }),
      state: 'output-available',
    })

    expect(presentation).toMatchObject({ language: 'Python', failed: true })
    expect(
      toolActivityLabel('run_script', presentation, 'output-available', t)
    ).toBe('toolCall.actions.script.error(Python)')
  })

  it('shows a running script and a timed-out one', () => {
    const running = presentTool({
      toolName: 'run_script',
      input: { language: 'javascript', code: 'console.log(1)' },
      state: 'input-available',
    })
    expect(toolActivityLabel('run_script', running, 'input-available', t)).toBe(
      'toolCall.actions.script.running(JavaScript)'
    )

    const timedOut = presentTool({
      toolName: 'run_command',
      input: { command: 'sleep 999' },
      output: output({ timedOut: true, exitCode: null }),
      state: 'output-available',
    })
    expect(timedOut).toMatchObject({ failed: true })
  })
})
