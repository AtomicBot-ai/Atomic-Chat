import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ToolCostHint from '../ToolCostHint'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import type { ToolCostReport } from '@/lib/tool-cost'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const heavyReport: ToolCostReport = {
  totalTokens: 18_000,
  toolCount: 71,
  ctxLen: 16_384,
  ctxShare: 18_000 / 16_384,
  perServer: [
    { server: 'linear', toolCount: 70, tokens: 17_800, ctxShare: 1.08, heavy: true },
    { server: 'exa', toolCount: 1, tokens: 200, ctxShare: 0.01, heavy: false },
  ],
  heavyServers: ['linear'],
  tooHeavy: true,
}

describe('ToolCostHint', () => {
  beforeEach(() => {
    useAppState.setState({ toolCostReports: {} })
    useToolAvailable.setState({ mutedServers: {}, defaultMutedServers: [] })
    useMCPServers.setState({ mcpServers: {} })
    useModelProvider.setState({ selectedProvider: 'llamacpp-upstream' })
  })

  it('renders nothing without a heavy report', () => {
    const { container } = render(<ToolCostHint threadId="t1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for cloud providers even when tools are heavy', () => {
    useAppState.setState({ toolCostReports: { t1: heavyReport } })
    useModelProvider.setState({ selectedProvider: 'openai' })
    const { container } = render(<ToolCostHint threadId="t1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the heavy connector and mutes it for this chat on click', () => {
    useAppState.setState({ toolCostReports: { t1: heavyReport } })
    render(<ToolCostHint threadId="t1" />)

    expect(screen.getByTestId('tool-cost-hint')).toBeInTheDocument()
    expect(screen.getByText(/toolCostHint\.title/)).toHaveTextContent('18k')
    fireEvent.click(screen.getByTestId('tool-cost-hint-mute-linear'))

    expect(
      useToolAvailable.getState().getMutedServersForThread('t1')
    ).toEqual(['linear'])
    // Other threads are untouched.
    expect(
      useToolAvailable.getState().getMutedServersForThread('t2')
    ).toEqual([])
  })

  it('writes the default for new chats from the index page', () => {
    useAppState.setState({ toolCostReports: { '': heavyReport } })
    render(<ToolCostHint initialMessage />)

    fireEvent.click(screen.getByTestId('tool-cost-hint-mute-linear'))
    expect(useToolAvailable.getState().getDefaultMutedServers()).toEqual([
      'linear',
    ])
  })
})
