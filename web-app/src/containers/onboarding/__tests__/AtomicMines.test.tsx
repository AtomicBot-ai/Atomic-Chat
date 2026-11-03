import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
// Atoms fill the fifth row and the last two cells, wherever the first move
// is: a move on top opens the four rows above the wall and no further.
vi.mock('@/lib/onboarding/mines', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onboarding/mines')>()),
  placeMines: () => [32, 33, 34, 35, 36, 37, 38, 39, 62, 63],
}))

import { AtomicMines } from '../steps/AtomicMines'

const cell = (row: number, column: number) =>
  within(
    screen.getByRole('group', { name: 'onboarding-wait:mines.board' })
  ).getByRole('button', {
    name: new RegExp(`mines\\.cell\\w+ ${row} ${column}`),
  })

describe('Atomic Mines', () => {
  it('opens an area on the first move and numbers its edge', () => {
    render(<AtomicMines />)

    fireEvent.click(cell(1, 1))

    expect(cell(1, 1)).toBeDisabled()
    expect(cell(1, 1)).toHaveAccessibleName(
      'onboarding-wait:mines.cellOpen 1 1 0'
    )
    expect(cell(4, 1)).toHaveTextContent('2')
    expect(cell(4, 4)).toHaveTextContent('3')
    expect(cell(6, 1)).toBeEnabled()
    expect(cell(8, 8)).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'onboarding-wait:mines.goal'
    )
  })

  it('flags by right-click or flag mode, counting what is left', () => {
    render(<AtomicMines />)
    expect(
      screen.getByText('onboarding-wait:mines.unmarked 10')
    ).toBeInTheDocument()

    fireEvent.contextMenu(cell(8, 8))
    expect(cell(8, 8)).toHaveAccessibleName(
      'onboarding-wait:mines.cellFlagged 8 8'
    )
    expect(
      screen.getByText('onboarding-wait:mines.unmarked 9')
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-wait:mines.flagMode' })
    )
    fireEvent.click(cell(8, 7))
    expect(
      screen.getByText('onboarding-wait:mines.unmarked 8')
    ).toBeInTheDocument()

    // A flagged cell is not opened by a click.
    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-wait:mines.flagModeOn' })
    )
    fireEvent.click(cell(8, 7))
    expect(cell(8, 7)).toHaveAccessibleName(
      'onboarding-wait:mines.cellFlagged 8 7'
    )
  })

  it('ends on an atom, and a new game starts over', () => {
    render(<AtomicMines />)
    fireEvent.click(cell(1, 1))

    fireEvent.click(cell(8, 8))

    expect(screen.getByRole('status')).toHaveTextContent(
      'onboarding-wait:mines.lost'
    )
    expect(cell(5, 5)).toBeDisabled()

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-wait:mines.newGame' })
    )
    expect(cell(1, 1)).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'onboarding-wait:mines.goal'
    )
  })
})
