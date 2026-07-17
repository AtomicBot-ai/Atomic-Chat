import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  ActivityDetail,
  AgentActivity,
} from '@/components/ai-elements/agent-activity'

describe('AgentActivity', () => {
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
    expect(container.querySelector('svg.animate-spin')).not.toBeNull()
    expect(screen.queryByText('Called 1 tool')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /working/i }))
    await user.click(screen.getByRole('button', { name: /called 1 tool/i }))

    expect(screen.getByText('Tool result')).toBeInTheDocument()
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
})
