import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import TokenSpeedIndicator from '@/containers/TokenSpeedIndicator'
import { useAppState } from '@/hooks/useAppState'

describe('TokenSpeedIndicator', () => {
  beforeEach(() => {
    useAppState.setState({ tokenSpeed: undefined })
  })

  it('keeps the output-token count visible when TPS is unavailable', () => {
    render(
      <TokenSpeedIndicator
        metadata={{ usage: { inputTokens: 631, outputTokens: 1_116 } }}
      />
    )

    expect(screen.getByText('1116 tokens')).toBeInTheDocument()
    expect(screen.queryByText(/tok\/sec/)).not.toBeInTheDocument()
  })

  it('shows both metrics when a reliable TPS value exists', () => {
    render(
      <TokenSpeedIndicator
        metadata={{
          usage: { inputTokens: 631, outputTokens: 594 },
          tokenSpeed: { tokenSpeed: 54.1, tokenCount: 594 },
        }}
      />
    )

    expect(screen.getByText('54 tok/sec')).toBeInTheDocument()
    expect(screen.getByText('594 tokens')).toBeInTheDocument()
  })
})
