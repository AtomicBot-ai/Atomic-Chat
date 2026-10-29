/**
 * Atomic Mines, the minesweeper on the first-run wait screen: an 8×8 board
 * with ten atoms, as in the prototype (`preview/onboarding/Mines.tsx`). Cells
 * are numbered row by row from 0. The board is pure data so the screen stays
 * a thin layer over it.
 */

export const MINES_SIZE = 8
export const MINES_CELLS = MINES_SIZE * MINES_SIZE
export const MINES_COUNT = 10

/** The up to eight cells touching `cell`. */
export function neighbors(cell: number): number[] {
  const row = Math.floor(cell / MINES_SIZE)
  const column = cell % MINES_SIZE
  const around: number[] = []
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = column - 1; c <= column + 1; c++) {
      if (r === row && c === column) continue
      if (r < 0 || c < 0 || r >= MINES_SIZE || c >= MINES_SIZE) continue
      around.push(r * MINES_SIZE + c)
    }
  }
  return around
}

/**
 * Lays the atoms once the first cell is opened, away from it and its
 * neighbours, so the first move is always safe and opens an area.
 */
export function placeMines(first: number, random = Math.random): number[] {
  const keepClear = new Set([first, ...neighbors(first)])
  const candidates = Array.from(
    { length: MINES_CELLS },
    (_, cell) => cell
  ).filter((cell) => !keepClear.has(cell))
  // Fisher–Yates; the first MINES_COUNT are the atoms.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  return candidates.slice(0, MINES_COUNT)
}

/** How many atoms touch `cell`. */
export function countAround(cell: number, mines: readonly number[]): number {
  return neighbors(cell).filter((n) => mines.includes(n)).length
}

/**
 * Opens `cell` and, where no atom touches it, the area around it, as far as
 * the numbers reach. Flags and atoms are never opened.
 */
export function revealCells(
  cell: number,
  mines: readonly number[],
  flags: readonly number[],
  opened: readonly number[]
): number[] {
  const result = new Set(opened)
  const pending = [cell]
  while (pending.length) {
    const next = pending.pop()!
    if (result.has(next) || flags.includes(next) || mines.includes(next)) {
      continue
    }
    result.add(next)
    if (countAround(next, mines) === 0) pending.push(...neighbors(next))
  }
  return [...result]
}

/** Every cell without an atom is open. */
export function isCleared(opened: readonly number[]): boolean {
  return opened.length === MINES_CELLS - MINES_COUNT
}
