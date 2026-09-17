import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AgentApprovalModeSelect } from '@/containers/AgentApprovalModeSelect'
import type { AgentApprovalMode } from '@/hooks/useAgentMode'
import chat from '@/locales/en/chat.json'

// The confirm dialog is sm:max-w-xl, which leaves 526 px per line of text
// after the padding. Two lines of 14 px Inter hold about 150 characters; at
// the "Large" font setting (15.75 px) about 135, measured with the app's
// Inter: the current body, 132 characters, is 940 px of the 1052 px two
// lines give, with the longest word (90 px) still fitting on either line.
const BODY_BUDGET = 135

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
    'No approval prompts: tool calls can modify or delete files, run commands, and use the internet. Enable it only for a task you trust.',
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

  it('centres the mode icon and the checkmark on each row', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={vi.fn()} />)

    await openMenu(user)

    const rows = screen.getAllByRole('menuitem')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      // The row centres the icon and the checkmark on the whole title +
      // description block. Pinned to the first line, they sat at the top of
      // the three-line Full access row and read as "flown up".
      expect(row).toHaveClass('items-center')
      expect(row).not.toHaveClass('items-start')
      const icons = row.querySelectorAll('svg')
      expect(icons).toHaveLength(2) // the mode icon and the checkmark
      for (const icon of icons) expect(icon).not.toHaveClass('mt-0.5')
    }
  })

  it('shows the Full access warning in a wider dialog that holds it in two lines', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={vi.fn()} />)

    await pickFullAccess(user)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('sm:max-w-xl', 'lg:max-w-xl', 'xl:max-w-xl')
    expect(dialog).not.toHaveClass('sm:max-w-md', 'lg:max-w-md', 'xl:max-w-md')

    // The shipped words are the pinned ones, they render, and they still
    // carry the whole warning within the two-line budget.
    const body = chat.agentApprovals.skipConfirmBody
    expect(body).toBe(COPY.skipConfirmBody)
    expect(dialog).toHaveTextContent(body)
    expect(body).toMatch(/modify or delete files/)
    expect(body).toMatch(/run commands/)
    expect(body).toMatch(/use the internet/)
    expect(body).toMatch(/only for a task you trust/)
    expect(body.length).toBeLessThanOrEqual(BODY_BUDGET)
  })
})
