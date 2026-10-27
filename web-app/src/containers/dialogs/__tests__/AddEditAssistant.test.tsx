import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import AddEditAssistant from '../AddEditAssistant'
import { defaultAssistant } from '@/hooks/useAssistant'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('emoji-picker-react', () => ({ default: () => null }))
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ isDark: true }) }))

const assistant = {
  ...defaultAssistant,
  id: 'winter',
  name: 'Winter',
  instructions: 'Keep this persona.',
  include_date: false,
  include_time: false,
}

describe('assistant message clock controls', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'saves independent date=%s and time=%s without changing instructions or sampling',
    (date, time) => {
      const onSave = vi.fn()
      render(
        <AddEditAssistant
          open
          editingKey="winter"
          initialData={assistant}
          onSave={onSave}
          onOpenChange={vi.fn()}
        />
      )
      if (date)
        fireEvent.click(
          screen.getByRole('switch', { name: 'assistants:includeDate' })
        )
      if (time)
        fireEvent.click(
          screen.getByRole('switch', { name: 'assistants:includeTime' })
        )
      fireEvent.click(screen.getByRole('button', { name: 'assistants:save' }))
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: assistant.instructions,
          parameters: assistant.parameters,
          include_date: date,
          include_time: time,
        })
      )
    }
  )

  it('restores saved toggle values and resets them when editing another assistant', () => {
    const props = { open: true, onSave: vi.fn(), onOpenChange: vi.fn() }
    const { rerender } = render(
      <AddEditAssistant
        {...props}
        editingKey="winter"
        initialData={{ ...assistant, include_date: true, include_time: true }}
      />
    )
    expect(
      screen.getByRole('switch', { name: 'assistants:includeDate' })
    ).toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'assistants:includeTime' })
    ).toBeChecked()
    rerender(
      <AddEditAssistant
        {...props}
        editingKey="other"
        initialData={{ ...assistant, id: 'other' }}
      />
    )
    expect(
      screen.getByRole('switch', { name: 'assistants:includeDate' })
    ).not.toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'assistants:includeTime' })
    ).not.toBeChecked()
  })
})
