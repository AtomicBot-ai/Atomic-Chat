/**
 * The falling-blocks animation for the download drawer.
 *
 * It is decoration tied to a process, not a measurement: blocks drop from the
 * top at one fixed rate for every download, regardless of file size or speed,
 * and stack up on the floor like Tetris. When the stack reaches a set height
 * the bottom rows flash, vanish, and everything above drops down, then it keeps
 * going. The real numbers (speed, size, progress) are shown beside it as text.
 *
 * Pure and deterministic given an `rng`, so the whole behaviour is testable
 * without a canvas or a clock.
 */

export type BlockField = {
  cols: number
  rows: number
  /** Per column, colour indices from the floor up. */
  stacks: number[][]
  falling: FallingBlock[]
  /** Blocks per second entering at the top. The same for every download. */
  spawnPerSecond: number
  /** Rows per second a block falls. */
  fallRowsPerSecond: number
  /** The stack height (in full rows) that triggers a clear. */
  clearAtRows: number
  /** How many bottom rows a clear removes. */
  clearRows: number
  spawnCarry: number
  clear: ClearAnimation | null
  /** Total rows cleared so far, for a tiny "lines" counter if wanted. */
  linesCleared: number
  /** Eased slide, in rows, of the stacks settling after a clear. */
  settle: number
  rng: () => number
}

export type FallingBlock = {
  col: number
  /** Top edge in rows from the top of the field; may be fractional. */
  y: number
  colour: number
}

export type ClearAnimation = {
  /** Seconds elapsed. */
  t: number
  rows: number
}

export const BLOCK_COLOURS = 4
export const CLEAR_FLASH_SECONDS = 0.4
export const CLEAR_VANISH_SECONDS = 0.35
export const CLEAR_SECONDS = CLEAR_FLASH_SECONDS + CLEAR_VANISH_SECONDS
const SETTLE_SECONDS = 0.25

export function createBlockField(options: {
  cols?: number
  rows?: number
  rng?: () => number
  spawnPerSecond?: number
  fallRowsPerSecond?: number
  clearAtRows?: number
  clearRows?: number
} = {}): BlockField {
  const cols = options.cols ?? 10
  const rows = options.rows ?? 18
  return {
    cols,
    rows,
    stacks: Array.from({ length: cols }, () => []),
    falling: [],
    spawnPerSecond: options.spawnPerSecond ?? 9,
    fallRowsPerSecond: options.fallRowsPerSecond ?? 11,
    clearAtRows: options.clearAtRows ?? Math.floor(rows * 0.55),
    clearRows: options.clearRows ?? 4,
    spawnCarry: 0,
    clear: null,
    linesCleared: 0,
    settle: 0,
    rng: options.rng ?? Math.random,
  }
}

/** Height of a column including blocks already on their way down to it. */
function pendingHeight(field: BlockField, col: number): number {
  return (
    field.stacks[col]!.length +
    field.falling.filter((block) => block.col === col).length
  )
}

/**
 * Which column the next block heads for. Mostly the lowest ones, so rows fill
 * evenly like a Tetris board being played well, with the odd one elsewhere so
 * it never looks mechanical.
 */
function pickColumn(field: BlockField): number {
  const heights = Array.from({ length: field.cols }, (_, col) =>
    pendingHeight(field, col)
  )
  const lowest = Math.min(...heights)
  const near = field.rng() < 0.15 ? lowest + 1 : lowest
  const candidates = heights
    .map((height, col) => ({ height, col }))
    .filter(({ height }) => height <= near)
  return candidates[Math.floor(field.rng() * candidates.length)]!.col
}

/** Height, in full rows, of the part of the stack that spans every column. */
export function fullRows(field: BlockField): number {
  return Math.min(...field.stacks.map((stack) => stack.length))
}

/** Advance the field by `dt` seconds. `paused` freezes spawning and falling. */
export function stepBlockField(
  field: BlockField,
  dt: number,
  paused = false
): void {
  const step = Math.min(Math.max(dt, 0), 0.05)

  if (field.settle > 0) {
    field.settle = Math.max(0, field.settle - step / SETTLE_SECONDS)
  }

  if (field.clear) {
    // The board holds still while rows flash and vanish, as in Tetris.
    field.clear.t += step
    if (field.clear.t >= CLEAR_SECONDS) {
      for (const stack of field.stacks) stack.splice(0, field.clear.rows)
      field.linesCleared += field.clear.rows
      field.settle = 1
      field.clear = null
    }
    return
  }
  if (paused) return

  field.spawnCarry += step * field.spawnPerSecond
  while (field.spawnCarry >= 1) {
    field.spawnCarry -= 1
    field.falling.push({
      col: pickColumn(field),
      y: -1,
      colour: Math.floor(field.rng() * BLOCK_COLOURS),
    })
  }

  const remaining: FallingBlock[] = []
  for (const block of field.falling) {
    block.y += field.fallRowsPerSecond * step
    const stack = field.stacks[block.col]!
    const restRow = field.rows - stack.length - 1
    if (block.y >= restRow) {
      stack.push(block.colour)
    } else {
      remaining.push(block)
    }
  }
  field.falling = remaining

  if (fullRows(field) >= field.clearAtRows) {
    field.clear = { t: 0, rows: field.clearRows }
  }
}
