import { describe, it, expect } from 'vitest'

import {
  appendSegment,
  captureAnchor,
  joinSegment,
  mergeDictation,
  revertDictation,
} from '../promptMerge'

describe('captureAnchor', () => {
  it('splits at the caret', () => {
    expect(captureAnchor('hello world', 5)).toEqual({
      before: 'hello',
      after: ' world',
    })
  })

  it('appends at the end when the field is not focused', () => {
    expect(captureAnchor('hello', null)).toEqual({ before: 'hello', after: '' })
    expect(captureAnchor('hello', undefined)).toEqual({
      before: 'hello',
      after: '',
    })
  })

  it('clamps a caret outside the value', () => {
    expect(captureAnchor('abc', 99)).toEqual({ before: 'abc', after: '' })
    expect(captureAnchor('abc', -4)).toEqual({ before: '', after: 'abc' })
  })
})

describe('joinSegment', () => {
  it('inserts exactly one space between words', () => {
    expect(joinSegment('Draft the', 'release notes')).toBe(
      'Draft the release notes'
    )
  })

  it('does not double a space that is already there', () => {
    expect(joinSegment('Draft the ', 'release notes')).toBe(
      'Draft the release notes'
    )
    expect(joinSegment('Draft the\n', 'release notes')).toBe(
      'Draft the\nrelease notes'
    )
  })

  it('lets closing punctuation hug the previous word', () => {
    expect(joinSegment('the fox', ', quickly')).toBe('the fox, quickly')
    expect(joinSegment('the fox', '. Then')).toBe('the fox. Then')
    expect(joinSegment('the fox', '?')).toBe('the fox?')
    expect(joinSegment('стоимость', '…')).toBe('стоимость…')
  })

  it('handles empty operands', () => {
    expect(joinSegment('', 'hello')).toBe('hello')
    expect(joinSegment('hello', '')).toBe('hello')
    expect(joinSegment('', '')).toBe('')
  })
})

describe('appendSegment', () => {
  it('accumulates phrases with single spaces', () => {
    let committed = ''
    committed = appendSegment(committed, 'The quick brown fox.')
    committed = appendSegment(committed, 'Jumps over the lazy dog.')
    expect(committed).toBe('The quick brown fox. Jumps over the lazy dog.')
  })

  it('trims model whitespace and ignores empty phrases', () => {
    expect(appendSegment('one', '  two  ')).toBe('one two')
    expect(appendSegment('one', '   ')).toBe('one')
    expect(appendSegment('one', '')).toBe('one')
  })
})

describe('mergeDictation', () => {
  it('splices at the caret and preserves the tail verbatim', () => {
    const anchor = captureAnchor('Send this to  tomorrow', 13)
    const { value, caret } = mergeDictation(anchor, 'the whole team')
    expect(value).toBe('Send this to the whole team tomorrow')
    expect(caret).toBe('Send this to the whole team'.length)
  })

  it('appends when the caret was at the end', () => {
    const anchor = captureAnchor('Draft the', 9)
    expect(mergeDictation(anchor, 'release notes').value).toBe(
      'Draft the release notes'
    )
  })

  it('starts from nothing when the composer was empty', () => {
    const anchor = captureAnchor('', 0)
    const merged = mergeDictation(anchor, 'Hello there')
    expect(merged.value).toBe('Hello there')
    expect(merged.caret).toBe('Hello there'.length)
    expect(merged.insertedLength).toBe('Hello there'.length)
  })

  it('keeps the tail from fusing onto the last dictated word', () => {
    const anchor = { before: 'A ', after: 'B' }
    expect(mergeDictation(anchor, 'middle').value).toBe('A middle B')
  })

  it('does not add a separator before punctuation in the tail', () => {
    const anchor = { before: 'Say ', after: '.' }
    expect(mergeDictation(anchor, 'hello').value).toBe('Say hello.')
  })

  it('is idempotent for the same committed text', () => {
    const anchor = captureAnchor('lead in |tail', 8)
    const first = mergeDictation(anchor, 'dictated words')
    const second = mergeDictation(anchor, 'dictated words')
    expect(second).toEqual(first)
  })

  it('reports an insertedLength that accounts for every added character', () => {
    const anchor = { before: 'A', after: 'B' }
    const { value, insertedLength } = mergeDictation(anchor, 'mid')
    // "A mid B" — one join space and one separator space.
    expect(value).toBe('A mid B')
    expect(insertedLength).toBe(value.length - 'A'.length - 'B'.length)
  })
})

describe('revertDictation', () => {
  it('restores the pre-dictation value exactly', () => {
    const anchor = captureAnchor('Send this to  tomorrow', 13)
    const { value, insertedLength } = mergeDictation(anchor, 'the whole team')
    const reverted = revertDictation(value, anchor, insertedLength)
    expect(reverted).toEqual({
      value: 'Send this to  tomorrow',
      caret: anchor.before.length,
    })
  })

  it('is a no-op round trip for an empty session', () => {
    const anchor = captureAnchor('untouched', 4)
    const { value, insertedLength } = mergeDictation(anchor, '')
    expect(revertDictation(value, anchor, insertedLength)).toEqual({
      value: 'untouched',
      caret: 4,
    })
  })

  it('refuses when the user edited the text ahead of the insertion', () => {
    const anchor = captureAnchor('Send to ', 8)
    const { value, insertedLength } = mergeDictation(anchor, 'the team')
    const edited = 'X' + value
    expect(revertDictation(edited, anchor, insertedLength)).toBeNull()
  })

  it('refuses when the user edited the preserved tail', () => {
    const anchor = { before: 'A ', after: 'B' }
    const { value, insertedLength } = mergeDictation(anchor, 'mid')
    const edited = value.slice(0, -1) + 'Z'
    expect(revertDictation(edited, anchor, insertedLength)).toBeNull()
  })

  it('refuses when the value got shorter than the recorded insertion', () => {
    const anchor = { before: 'A ', after: 'B' }
    expect(revertDictation('A ', anchor, 40)).toBeNull()
  })
})
