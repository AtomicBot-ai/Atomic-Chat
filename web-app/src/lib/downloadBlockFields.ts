import { createBlockField, type BlockField } from './downloadBlocks'

export const COLS = 10
export const ROWS = 18

/** One accent per download, in the order they started. */
export const DOWNLOAD_HUES = [152, 268, 46, 205, 22, 330] as const

export function hueFor(index: number): number {
  return DOWNLOAD_HUES[index % DOWNLOAD_HUES.length]!
}

const fields = new Map<string, BlockField>()

/** Forget the fields of downloads that are gone. */
export function pruneBlockFields(activeIds: string[]) {
  const keep = new Set(activeIds)
  for (const id of [...fields.keys()]) if (!keep.has(id)) fields.delete(id)
}

export function fieldFor(id: string): BlockField {
  let field = fields.get(id)
  if (!field) {
    field = createBlockField({ cols: COLS, rows: ROWS })
    fields.set(id, field)
  }
  return field
}

