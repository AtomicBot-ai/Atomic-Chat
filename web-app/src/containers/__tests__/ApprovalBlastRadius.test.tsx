import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ApprovalBlastRadius } from '@/containers/ApprovalBlastRadius'
import {
  readAgentReason,
  readBlastRadius,
  readChangeReview,
} from '@/lib/blast-radius'

const preview = {
  action: 'Change the DNS servers of Wi-Fi to 1.1.1.1.',
  adapter: 'Wi-Fi',
  blastRadius: {
    action: 'Change the DNS servers of Wi-Fi to 1.1.1.1.',
    changes: 'Wi-Fi will look up website names using 1.1.1.1.',
    disruption: 'A moment while caches refresh.',
    affects: 'All apps using that adapter.',
    undo: 'Run net.set_dns again with the previous servers.',
    needsAdmin: true,
    needsReboot: false,
    risk: 'medium',
  },
}

describe('readBlastRadius', () => {
  it('reads the blast radius a network fix sends', () => {
    expect(readBlastRadius(preview)).toMatchObject({
      risk: 'medium',
      needsAdmin: true,
      needsReboot: false,
    })
  })

  it('ignores previews without one or with an unknown risk', () => {
    expect(readBlastRadius({ path: 'notes.txt' })).toBeNull()
    expect(readBlastRadius(null)).toBeNull()
    expect(
      readBlastRadius({
        blastRadius: { ...preview.blastRadius, risk: 'catastrophic' },
      })
    ).toBeNull()
  })
})

describe('ApprovalBlastRadius', () => {
  it('shows the action, its consequences, risk and admin need up front', () => {
    render(<ApprovalBlastRadius radius={readBlastRadius(preview)!} />)
    expect(
      screen.getByText('Change the DNS servers of Wi-Fi to 1.1.1.1.')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Run net.set_dns again with the previous servers.')
    ).toBeInTheDocument()
    expect(
      screen.getByText('chat:agentApproval.blastRadius.risk.medium')
    ).toBeInTheDocument()
    expect(
      screen.getByText('chat:agentApproval.blastRadius.needsAdmin')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('chat:agentApproval.blastRadius.needsReboot')
    ).toBeNull()
  })
})

describe('second opinion', () => {
  const reviewed = {
    ...preview,
    agentReason: 'DNS lookups take over 2 seconds',
    review: {
      verdict: 'concern',
      reason: 'Flushing the DNS cache is smaller and should come first.',
    },
  }

  it('reads the reviewer verdict and the agent reason', () => {
    expect(readChangeReview(reviewed)).toEqual({
      verdict: 'concern',
      reason: 'Flushing the DNS cache is smaller and should come first.',
    })
    expect(readAgentReason(reviewed)).toBe('DNS lookups take over 2 seconds')
    expect(readChangeReview({ review: { verdict: 'perhaps' } })).toBeNull()
    expect(readAgentReason(preview)).toBeNull()
  })

  it('shows why the agent wants the change and what the reviewer thinks', () => {
    render(
      <ApprovalBlastRadius
        radius={readBlastRadius(reviewed)!}
        agentReason={readAgentReason(reviewed)}
        review={readChangeReview(reviewed)}
      />
    )
    expect(
      screen.getByText('DNS lookups take over 2 seconds')
    ).toBeInTheDocument()
    const review = screen.getByTestId('approval-review')
    expect(review).toHaveTextContent(
      'chat:agentApproval.blastRadius.review.concern'
    )
    expect(review).toHaveTextContent('Flushing the DNS cache is smaller')
  })

  it('shows no second opinion when there is none', () => {
    render(<ApprovalBlastRadius radius={readBlastRadius(preview)!} />)
    expect(screen.queryByTestId('approval-review')).toBeNull()
  })
})
