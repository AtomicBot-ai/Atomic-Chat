import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('emoji-picker-react', () => ({
  default: () => null,
  Theme: { DARK: 'dark', LIGHT: 'light' },
}))

import AddEditAssistant from '@/containers/dialogs/AddEditAssistant'

const existing: Assistant = {
  id: 'network',
  name: 'Network',
  created_at: 1,
  description: 'Diagnoses Wi-Fi, DNS and LAN problems',
  instructions: 'Prefer read-only checks.',
  parameters: {},
  specialist: true,
}

function renderDialog(initialData?: Assistant) {
  const onSave = vi.fn()
  render(
    <AddEditAssistant
      open
      onOpenChange={vi.fn()}
      editingKey={initialData?.id ?? null}
      initialData={initialData}
      onSave={onSave}
    />
  )
  return onSave
}

describe('AddEditAssistant specialist switch', () => {
  it('keeps an assistant a specialist when it is edited', async () => {
    const user = userEvent.setup()
    const onSave = renderDialog(existing)

    expect(screen.getByRole('switch')).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'assistants:save' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 'network', specialist: true })
  })

  it('saves a new assistant as a specialist once switched on', async () => {
    const user = userEvent.setup()
    const onSave = renderDialog()

    await user.type(
      screen.getByPlaceholderText('assistants:enterName'),
      'Computer care'
    )
    await user.type(
      screen.getByPlaceholderText('assistants:enterDescription'),
      'Keeps the PC healthy'
    )
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'assistants:save' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({ name: 'Computer care', specialist: true })
  })

  it('refuses a specialist without a description', async () => {
    const user = userEvent.setup()
    const onSave = renderDialog()

    await user.type(
      screen.getByPlaceholderText('assistants:enterName'),
      'Vague'
    )
    await user.click(screen.getByRole('switch'))
    await user.click(screen.getByRole('button', { name: 'assistants:save' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText('assistants:specialistNeedsDescription')
    ).toBeInTheDocument()
  })

  it('leaves an ordinary assistant out of the roster', async () => {
    const user = userEvent.setup()
    const onSave = renderDialog()

    await user.type(
      screen.getByPlaceholderText('assistants:enterName'),
      'Writer'
    )
    await user.click(screen.getByRole('button', { name: 'assistants:save' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({ name: 'Writer', specialist: false })
  })
})
