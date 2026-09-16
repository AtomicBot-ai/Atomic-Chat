import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AgentApprovalModeSelect } from '@/containers/AgentApprovalModeSelect'
import type { AgentApprovalMode } from '@/hooks/useAgentMode'

// The copy Danny signed off on (en/chat.json → agentApprovals); the component
// takes it as props, so the test pins the words the user reads.
const COPY = {
  menuTitle: 'How should tool calls be approved?',
  manualSelectedLabel: 'Ask for approval',
  manualLabel: 'Ask for approval',
  manualDescription:
    'Always ask before tool calls edit files or use the internet',
  skipSelectedLabel: 'Full access',
  skipLabel: 'Full access',
  skipDescription:
    'Unrestricted: no approval prompts for any tool call, including the internet and any file on your computer',
  skipConfirmTitle: 'Enable Full access?',
  skipConfirmBody:
    'Full access lets tool calls run without approval prompts. They can modify or delete files, run commands, and make network requests. Enable it only when you trust the current task.',
  skipConfirmCancel: 'Cancel',
  skipConfirmAccept: 'I understand',
}

/** The composer: holds the mode and re-renders the trigger with it. */
function Harness({
  initial = 'manual',
  onChange,
}: {
  initial?: AgentApprovalMode
  onChange: (mode: AgentApprovalMode) => void
}) {
  const [mode, setMode] = useState<AgentApprovalMode>(initial)
  return (
    <AgentApprovalModeSelect
      mode={mode}
      onChange={(next) => {
        onChange(next)
        setMode(next)
      }}
      {...COPY}
    />
  )
}

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Ask for approval' }))
  expect(screen.getByText(COPY.menuTitle)).toBeInTheDocument()
}

const pickFullAccess = async (user: ReturnType<typeof userEvent.setup>) => {
  await openMenu(user)
  await user.click(screen.getByRole('menuitem', { name: /Full access/ }))
}

describe('AgentApprovalModeSelect', () => {
  it('describes both modes in the menu', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={vi.fn()} />)

    await openMenu(user)

    expect(
      screen.getByRole('menuitem', { name: /Ask for approval/ })
    ).toHaveTextContent(COPY.manualDescription)
    expect(
      screen.getByRole('menuitem', { name: /Full access/ })
    ).toHaveTextContent(COPY.skipDescription)
    expect(screen.queryByText(/sandbox/i)).not.toBeInTheDocument()
  })

  it('asks before enabling Full access instead of switching at once', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await pickFullAccess(user)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent(COPY.skipConfirmTitle)
    expect(dialog).toHaveTextContent(COPY.skipConfirmBody)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'I understand' })
    ).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    // The trigger still says the old mode: nothing changed yet. (The modal
    // hides the rest of the page from the accessibility tree while open.)
    expect(
      screen.getByRole('button', { name: 'Ask for approval', hidden: true })
    ).toBeInTheDocument()
  })

  it('switches to Full access once the user says they understand', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await pickFullAccess(user)
    await user.click(screen.getByRole('button', { name: 'I understand' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('skip')
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(
      screen.getByRole('button', { name: 'Full access' })
    ).toBeInTheDocument()
  })

  it('keeps the mode when the user cancels', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await pickFullAccess(user)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(onChange).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Ask for approval' })
    ).toBeInTheDocument()
  })

  it('keeps the mode when the user presses Escape', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await pickFullAccess(user)
    await user.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )
    expect(onChange).not.toHaveBeenCalled()
    expect(
      screen.getByRole('button', { name: 'Ask for approval' })
    ).toBeInTheDocument()
  })

  it('asks again the next time Full access is picked', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await pickFullAccess(user)
    await user.click(screen.getByRole('button', { name: 'I understand' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    )

    // Back to Ask for approval, then Full access once more.
    await user.click(screen.getByRole('button', { name: 'Full access' }))
    await user.click(screen.getByRole('menuitem', { name: /Ask for approval/ }))
    expect(onChange).toHaveBeenLastCalledWith('manual')
    await pickFullAccess(user)

    expect(screen.getByRole('dialog')).toHaveTextContent(COPY.skipConfirmTitle)
    expect(onChange).not.toHaveBeenCalledWith('skip', expect.anything())
    expect(onChange.mock.calls.filter(([m]) => m === 'skip')).toHaveLength(1)
  })

  it('switches to Ask for approval without asking', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial="skip" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Full access' }))
    await user.click(screen.getByRole('menuitem', { name: /Ask for approval/ }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('manual')
    expect(
      screen.getByRole('button', { name: 'Ask for approval' })
    ).toBeInTheDocument()
  })
})
