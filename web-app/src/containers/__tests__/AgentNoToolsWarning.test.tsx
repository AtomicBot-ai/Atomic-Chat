import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentNoToolsWarning } from '../AgentNoToolsWarning'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { withTranslations } from '@/test/layout'

describe('Agent no-tool fallback', () => {
  beforeEach(() => {
    act(() => useGeneralSetting.setState({ agentModeEnabled: true }))
  })

  it('turns off Agent mode only after the user chooses the fallback', () => {
    render(withTranslations(<AgentNoToolsWarning allowFallback />))
    expect(screen.getByRole('status')).toHaveTextContent(
      'last two Agent replies'
    )
    expect(screen.getByRole('status')).toHaveTextContent('model picker')
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Agent mode' }))
    expect(useGeneralSetting.getState().agentModeEnabled).toBe(false)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not offer a global fallback on historical messages', () => {
    render(withTranslations(<AgentNoToolsWarning allowFallback={false} />))
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not offer the fallback when Agent mode is already off', () => {
    act(() => useGeneralSetting.setState({ agentModeEnabled: false }))
    render(withTranslations(<AgentNoToolsWarning allowFallback />))
    expect(screen.queryByRole('button')).toBeNull()
  })
})
