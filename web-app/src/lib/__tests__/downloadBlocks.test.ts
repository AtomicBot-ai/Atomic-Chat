import { describe, expect, it } from 'vitest'

import {
  CLEAR_SECONDS,
  createBlockField,
  fullRows,
  stepBlockField,
} from '../downloadBlocks'

/** A small deterministic generator, so a run is repeatable. */
function seeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function run(field: ReturnType<typeof createBlockField>, seconds: number, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) stepBlockField(field, dt)
}

describe('falling blocks', () => {
  it('drops blocks from the top and stacks them on the floor', () => {
    const field = createBlockField({ rng: seeded(1) })
    run(field, 2)
    const stacked = field.stacks.reduce((sum, stack) => sum + stack.length, 0)
    expect(stacked).toBeGreaterThan(0)
    expect(field.falling.every((block) => block.y < field.rows)).toBe(true)
  })

  it('fills rows evenly rather than piling up one column', () => {
    const field = createBlockField({ rng: seeded(2) })
    run(field, 3)
    const heights = field.stacks.map((stack) => stack.length)
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(3)
  })

  it('clears the bottom rows once the stack reaches the line, then keeps going', () => {
    const field = createBlockField({ rng: seeded(3), clearAtRows: 8, clearRows: 4 })
    let clearing = false
    let heightBefore = 0
    let heightAfter = 0
    for (let i = 0; i < 60 * 30 && field.linesCleared === 0; i += 1) {
      stepBlockField(field, 1 / 60)
      if (field.clear && !clearing) {
        clearing = true
        heightBefore = fullRows(field)
      }
    }
    heightAfter = fullRows(field)
    expect(clearing).toBe(true)
    expect(field.linesCleared).toBe(4)
    expect(heightBefore).toBeGreaterThanOrEqual(8)
    expect(heightAfter).toBe(heightBefore - 4)

    // Blocks keep falling afterwards.
    const before = field.stacks.reduce((sum, stack) => sum + stack.length, 0)
    run(field, 1)
    expect(field.stacks.reduce((sum, stack) => sum + stack.length, 0)).toBeGreaterThan(before)
  })

  it('holds the board still while rows clear', () => {
    const field = createBlockField({ rng: seeded(4), clearAtRows: 3 })
    for (let i = 0; i < 60 * 20 && !field.clear; i += 1) stepBlockField(field, 1 / 60)
    expect(field.clear).not.toBeNull()
    const snapshot = JSON.stringify(field.stacks)
    stepBlockField(field, 0.05)
    expect(JSON.stringify(field.stacks)).toBe(snapshot)
    expect(CLEAR_SECONDS).toBeGreaterThan(0)
  })

  it('never lets a column grow past the field', () => {
    const field = createBlockField({ rng: seeded(5) })
    run(field, 60)
    expect(Math.max(...field.stacks.map((stack) => stack.length))).toBeLessThanOrEqual(field.rows)
  })

  it('does not move while paused', () => {
    const field = createBlockField({ rng: seeded(6) })
    run(field, 1)
    const snapshot = JSON.stringify([field.stacks, field.falling])
    for (let i = 0; i < 30; i += 1) stepBlockField(field, 1 / 60, true)
    expect(JSON.stringify([field.stacks, field.falling])).toBe(snapshot)
  })

  it('runs at the same rate whatever the frame time', () => {
    const slow = createBlockField({ rng: seeded(7) })
    const fast = createBlockField({ rng: seeded(7) })
    run(slow, 2, 1 / 30)
    run(fast, 2, 1 / 120)
    const count = (f: typeof slow) =>
      f.stacks.reduce((s, st) => s + st.length, 0) + f.falling.length
    expect(Math.abs(count(slow) - count(fast))).toBeLessThanOrEqual(2)
  })
})
