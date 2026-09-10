/**
 * Caret and splice math for dictation.
 *
 * Dictated text is spliced into the composer at the caret position the user had
 * when they pressed the microphone. Everything to the right of that caret is
 * preserved, and the whole insertion is recomputed from scratch on every new
 * phrase — so the operation is idempotent and a single `revertDictation` can
 * undo the entire session.
 *
 * These functions are pure on purpose: they carry all the fiddly spacing and
 * offset logic that is painful to debug through a React tree.
 */

export type DictationAnchor = {
  /** Text left of the caret when dictation started. */
  before: string
  /** Text right of the caret when dictation started. Preserved verbatim. */
  after: string
}

/**
 * Punctuation that must hug the preceding word rather than being pushed off it
 * by a separator space. Voxtral routinely returns a phrase that opens with one
 * when the previous phrase ended mid-sentence.
 */
const HUGS_PREVIOUS_WORD = /^[\s,.!?;:)\]}»”’…%]/

const ENDS_WITH_WHITESPACE = /\s$/

/** Split `value` at the caret. A null caret (unfocused field) appends at the end. */
export function captureAnchor(
  value: string,
  caret: number | null | undefined
): DictationAnchor {
  if (caret === null || caret === undefined) {
    return { before: value, after: '' }
  }
  const clamped = Math.max(0, Math.min(caret, value.length))
  return { before: value.slice(0, clamped), after: value.slice(clamped) }
}

/**
 * Join two fragments with exactly one space — unless `before` is empty or
 * already ends in whitespace, or `segment` opens with punctuation that belongs
 * to the previous word.
 */
export function joinSegment(before: string, segment: string): string {
  if (!segment) return before
  if (!before) return segment
  if (ENDS_WITH_WHITESPACE.test(before)) return before + segment
  if (HUGS_PREVIOUS_WORD.test(segment)) return before + segment
  return `${before} ${segment}`
}

/** Accumulate one finalized phrase into the session's committed buffer. */
export function appendSegment(committed: string, segment: string): string {
  const trimmed = segment.trim()
  if (!trimmed) return committed
  return joinSegment(committed, trimmed)
}

export type DictationMerge = {
  value: string
  caret: number
  /** Characters this session added between `before` and `after`. */
  insertedLength: number
}

/**
 * Recompute the whole composer value for the current committed transcript.
 *
 * Always derived from the anchor, never appended to the live value, so calling
 * it twice with the same `committed` is a no-op and a dropped render cannot
 * duplicate a phrase.
 */
export function mergeDictation(
  anchor: DictationAnchor,
  committed: string
): DictationMerge {
  const head = joinSegment(anchor.before, committed)
  const tail = anchor.after

  // Keep the preserved tail from fusing onto the last dictated word.
  const needsSeparator =
    head.length > 0 &&
    tail.length > 0 &&
    !ENDS_WITH_WHITESPACE.test(head) &&
    !HUGS_PREVIOUS_WORD.test(tail)

  const value = needsSeparator ? `${head} ${tail}` : head + tail

  return {
    value,
    // The caret sits at the end of the dictated text, so the next phrase lands
    // where this one left off and manual typing continues naturally.
    caret: head.length,
    insertedLength: value.length - anchor.before.length - anchor.after.length,
  }
}

/**
 * Remove exactly what this session inserted.
 *
 * Returns null when the surrounding text no longer matches the anchor — the
 * user edited the field mid-session, and blindly splicing would eat their
 * characters. Callers treat null as "keep the text".
 */
export function revertDictation(
  value: string,
  anchor: DictationAnchor,
  insertedLength: number
): { value: string; caret: number } | null {
  if (insertedLength < 0) return null
  const tailStart = anchor.before.length + insertedLength
  if (tailStart > value.length) return null
  if (!value.startsWith(anchor.before)) return null
  if (value.slice(tailStart) !== anchor.after) return null

  return {
    value: anchor.before + anchor.after,
    caret: anchor.before.length,
  }
}
