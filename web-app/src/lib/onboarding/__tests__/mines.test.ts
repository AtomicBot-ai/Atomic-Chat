import { describe, expect, it } from 'vitest'

import {
  MINES_CELLS,
  MINES_COUNT,
  countAround,
  isCleared,
  neighbors,
  placeMines,
  revealCells,
} from '../mines'

describe('Atomic Mines board', () => {
  it('knows the neighbours of corner, edge and inner cells', () => {
    expect(neighbors(0).sort((a, b) => a - b)).toEqual([1, 8, 9])
    expect(neighbors(7).sort((a, b) => a - b)).toEqual([6, 14, 15])
    expect(neighbors(4)).toHaveLength(5)
    expect(neighbors(27)).toHaveLength(8)
  })

  it('keeps the first cell and its neighbours clear, whatever the draw', () => {
    for (const first of [0, 7, 27, 63]) {
      for (const draw of [0, 0.5, 0.999]) {
        const mines = placeMines(first, () => draw)
        expect(new Set(mines).size).toBe(MINES_COUNT)
        expect(mines).not.toContain(first)
        for (const cell of neighbors(first)) expect(mines).not.toContain(cell)
        for (const cell of mines) {
          expect(cell).toBeGreaterThanOrEqual(0)
          expect(cell).toBeLessThan(MINES_CELLS)
        }
      }
    }
  })

  it('opens an empty area as far as the numbers, never a flag', () => {
    // Atoms along the bottom row and the start of the row above.
    const mines = [56, 57, 58, 59, 60, 61, 62, 63, 48, 49]
    const opened = revealCells(0, mines, [5], [])

    expect(opened).toContain(0)
    expect(opened).toContain(47)
    expect(opened).not.toContain(5)
    for (const atom of mines) expect(opened).not.toContain(atom)
    // A numbered cell is opened but not spread from.
    expect(countAround(40, mines)).toBe(2)
    expect(opened).toContain(40)
  })

  it('is cleared once every cell without an atom is open', () => {
    const mines = Array.from({ length: MINES_COUNT }, (_, i) => i)
    const safe = Array.from({ length: MINES_CELLS }, (_, i) => i).filter(
      (cell) => !mines.includes(cell)
    )
    expect(isCleared(safe)).toBe(true)
    expect(isCleared(safe.slice(1))).toBe(false)
  })
})
