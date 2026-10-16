import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

import ToolApproval from '../ToolApproval'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useChatExecStatus } from '@/hooks/useChatExecStatus'
import type { ChatExecStatus } from '@/services/chat-exec/types'

const windows = (sandbox: ChatExecStatus['sandbox']): ChatExecStatus => ({
  supported: true,
  os: 'windows',
  shell: 'cmd',
  languages: ['python'],
  sandbox,
  userFolders: [],
})

function open(toolName: string, toolParameters: object) {
  useToolApproval.setState({
    isModalOpen: true,
    modalProps: {
      toolName,
      threadId: 't1',
      toolParameters,
      onApprove: vi.fn(),
      onDeny: vi.fn(),
    },
  })
  render(<ToolApproval />)
}

describe('ToolApproval for commands and scripts', () => {
  beforeEach(() => {
    useChatExecStatus.setState({
      status: windows({ kind: 'mxc', reason: null }),
    })
  })

  it('shows the command itself and that it runs in the Windows sandbox', () => {
    open('run_command', { command: 'dir /s', timeout_seconds: 30 })

    expect(
      screen.getByText('tools:toolApproval.exec.commandTitle')
    ).toBeInTheDocument()
    expect(screen.getByTestId('exec-approval-source')).toHaveTextContent(
      'dir /s'
    )
    expect(
      screen.getByText(/tools:toolApproval\.exec\.sandboxed/)
    ).toHaveTextContent('{"seconds":30}')
    expect(
      screen.queryByText('tools:toolApproval.parameters')
    ).not.toBeInTheDocument()
  })

  it('names the script language and says why Windows runs it unsandboxed', () => {
    useChatExecStatus.setState({
      status: windows({ kind: 'none', reason: 'Windows is too old' }),
    })

    open('run_script', { language: 'python', code: 'print(42)' })

    expect(
      screen.getByText(
        'tools:toolApproval.exec.scriptTitle {"language":"Python"}'
      )
    ).toBeInTheDocument()
    expect(screen.getByTestId('exec-approval-source')).toHaveTextContent(
      'print(42)'
    )
    expect(
      screen.getByText(/tools:toolApproval\.exec\.unsandboxedWindows/)
    ).toHaveTextContent('Windows is too old')
  })

  it('keeps the parameter view for any other tool', () => {
    open('search', { query: 'alpha' })

    expect(screen.getByText('tools:toolApproval.title')).toBeInTheDocument()
    expect(
      screen.getByText('tools:toolApproval.parameters')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('exec-approval-source')).not.toBeInTheDocument()
  })
})
