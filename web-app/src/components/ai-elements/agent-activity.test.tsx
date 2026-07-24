import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ActivityDetail,
  AgentActivity,
} from '@/components/ai-elements/agent-activity'
import { Tool } from '@/components/ai-elements/tools/tool'
import { ToolRenderer } from '@/components/ai-elements/tools/tool-renderer'

describe('AgentActivity', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('shows Working while active and reveals compact details', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <AgentActivity
        active
        workingLabel="Working"
        durationLabel="Worked for 3 s"
      >
        <ActivityDetail label="Called 1 tool">
          <span>Tool result</span>
        </ActivityDetail>
      </AgentActivity>
    )

    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(container.querySelector('svg.animate-spin')).toBeNull()
    expect(screen.queryByText('Called 1 tool')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /working/i }))
    await user.click(screen.getByRole('button', { name: /called 1 tool/i }))

    expect(screen.getByText('Tool result')).toBeInTheDocument()
  })

  it('hides the disclosure icon until details exist', () => {
    const { container } = render(
      <AgentActivity
        active
        workingLabel="Working"
        durationLabel="Worked for 1 s"
        hasDetails={false}
      >
        {null}
      </AgentActivity>
    )

    expect(container.querySelectorAll('svg')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /working/i })).toBeDisabled()
  })

  it('shows the completed duration label', () => {
    render(
      <AgentActivity
        active={false}
        workingLabel="Working"
        durationLabel="Worked for 3 s"
      >
        <span>Details</span>
      </AgentActivity>
    )

    expect(screen.getByText('Worked for 3 s')).toBeInTheDocument()
  })

  it('keeps multiline tool parameters inside nested compact details', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <AgentActivity
        active={false}
        workingLabel="Working"
        durationLabel="Worked for 2 s"
      >
        <ActivityDetail label="Called 1 tool">
          <Tool state="output-available">
            <ToolRenderer
              state="output-available"
              presentation={{
                kind: 'generic',
                title: 'Wrote file',
                input: {
                  path: 'src/example.ts',
                  content: 'export const first = 1\nexport const second = 2',
                },
                output: { ok: true },
              }}
            />
          </Tool>
        </ActivityDetail>
      </AgentActivity>
    )

    expect(screen.queryByText('Called 1 tool')).not.toBeInTheDocument()
    expect(screen.queryByText('export const first = 1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /worked for 2 s/i }))
    await user.click(screen.getByRole('button', { name: /called 1 tool/i }))
    await user.click(screen.getByRole('button', { name: /wrote file/i }))

    expect(container).toHaveTextContent('export const first = 1')
  })
})
