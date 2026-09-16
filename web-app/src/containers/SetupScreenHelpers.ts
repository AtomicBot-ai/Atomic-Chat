/**
 * Pure helpers behind the first-run screen's per-row fit mark: the colour a
 * memory verdict maps onto, and the order the picks are listed in. Kept free
 * of React and of `SetupScreen` itself so they are testable without a render
 * and so the screen can import them without a cycle.
 */
import type { MemoryFit } from '@/lib/hardware-tier'

/**
 * The three colours a row can wear. `ok` is green, `warn` yellow, `no` red.
 * `null` is "we don't know" — no size, or no hardware profile — and is drawn
 * as nothing at all, never as a warning.
 */
export type FitLevel = 'ok' | 'warn' | 'no'

/**
 * Four verdicts onto three colours: `tight` and `spills` both mean "it will
 * run, expect less of it", and one warning colour is enough for that — the
 * tooltip's sentence tells the two apart.
 */
export function fitLevel(fit: MemoryFit | null | undefined): FitLevel | null {
  switch (fit) {
    case 'comfortable':
      return 'ok'
    case 'tight':
    case 'spills':
      return 'warn'
    case 'wont_load':
      return 'no'
    default:
      return null
  }
}

/** Short label read out before the reason, one per colour. */
export function fitLabelKey(level: FitLevel): string {
  return {
    ok: 'setup:recommend.fitOk',
    warn: 'setup:recommend.fitWarn',
    no: 'setup:recommend.fitNo',
  }[level]
}

/** Listing order of the colour groups; the unknown group goes last. */
const FIT_LEVEL_ORDER: ReadonlyArray<FitLevel | null> = [
  'ok',
  'warn',
  'no',
  null,
]

/**
 * Lists the rows by colour — what fits, then what is tight, then what will not
 * load, then what could not be judged — and inside each group deals them with
 * `interleave` so no two neighbours share a publisher where the group allows
 * it. Each group starts from the publisher of the row before it: the last row
 * of the previous group, or `previous` for the first — the row rendered above
 * the list (the offer), which is never part of `rows`.
 *
 * The groups are never reordered to improve the interleave: a red row does
 * not move up to part two green ones. Fit is the stronger signal.
 */
export function orderRowsByFit<T>(
  rows: readonly T[],
  options: {
    levelOf: (row: T) => FitLevel | null
    keyOf: (row: T) => string
    interleave: (
      group: readonly T[],
      keyOf: (row: T) => string,
      previous?: string
    ) => T[]
    previous?: string
  }
): T[] {
  const { levelOf, keyOf, interleave, previous } = options
  const out: T[] = []
  let last = previous
  for (const level of FIT_LEVEL_ORDER) {
    const group = rows.filter((row) => levelOf(row) === level)
    if (group.length === 0) continue
    const dealt = interleave(group, keyOf, last)
    out.push(...dealt)
    last = keyOf(dealt[dealt.length - 1])
  }
  return out
}
