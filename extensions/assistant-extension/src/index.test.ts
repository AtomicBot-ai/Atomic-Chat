/**
 * Migrations v3 and v4 - renaming the product inside saved assistants.
 *
 * This runs against a user's real assistant files, so the behaviour that
 * matters is not "does it rename" but what it leaves ALONE. Migrations v1 and
 * v2 replaced the whole instruction field, which was safe only while that text
 * was still the shipped default. By now a user may have written their own, and
 * overwriting it would destroy work with no way back.
 */
import { describe, expect, it } from 'vitest'

import {
  renameProductInAssistantName,
  renameProductInInstructions,
} from './index'

describe('renameProductInInstructions', () => {
  it('renames the product where it appears', () => {
    expect(
      renameProductInInstructions(
        'You are Atomic Chat, a helpful AI assistant.'
      )
    ).toBe('You are Radium, a helpful AI assistant.')
  })

  it('renames the interim name too, for installs that already ran v3', () => {
    expect(
      renameProductInInstructions(
        'You are Radium Chat, a helpful AI assistant.'
      )
    ).toBe('You are Radium, a helpful AI assistant.')
  })

  it('renames both former names when one text carries each', () => {
    expect(
      renameProductInInstructions('Atomic Chat, now called Radium Chat.')
    ).toBe('Radium, now called Radium.')
  })

  it('renames every occurrence, not just the first', () => {
    const before =
      'You are Atomic Chat. Atomic Chat is trained by Atomic Chat (https://atomic.chat).'
    const after =
      'You are Radium. Radium is trained by Radium (https://atomic.chat).'

    expect(renameProductInInstructions(before)).toBe(after)
  })

  it("preserves the user's own wording around the name", () => {
    const before = [
      'Always answer in French.',
      'You are Atomic Chat, my personal assistant.',
      'Never use bullet points. Signed, Warwick.',
    ].join('\n')

    const result = renameProductInInstructions(before) as string

    // Only the name itself may differ.
    expect(result).toBe(before.replace('Atomic Chat', 'Radium'))
    expect(result).toContain('Always answer in French.')
    expect(result).toContain('Never use bullet points. Signed, Warwick.')
    expect(result.split('\n')).toHaveLength(3)
  })

  it('leaves the domain alone, which was not renamed', () => {
    const result = renameProductInInstructions(
      'Atomic Chat lives at https://atomic.chat'
    )

    expect(result).toBe('Radium lives at https://atomic.chat')
  })

  it('returns instructions with no mention completely untouched', () => {
    const custom = 'You are a terse assistant. Answer in one sentence.'

    // The caller uses `===` to decide whether to write the file at all, and JS
    // compares primitive strings by value, so an unchanged instruction never
    // triggers a rewrite. (Deliberately not asserting reference identity: that
    // is not a thing JS strings have, and a mutation dropping the early-return
    // guard is genuinely equivalent rather than a bug this could catch.)
    expect(renameProductInInstructions(custom)).toBe(custom)
    expect(renameProductInInstructions('You are Radium.')).toBe(
      'You are Radium.'
    )
  })

  it('handles an assistant with no instructions at all', () => {
    expect(renameProductInInstructions(undefined)).toBeUndefined()
    expect(renameProductInInstructions('')).toBe('')
  })

  it('renames the name even where it starts a longer word', () => {
    // A plain substring swap, as it has been since v3: "Atomic Chatbot" was
    // never a real phrase in any shipped instruction, so this pins the
    // behaviour rather than defending it.
    expect(renameProductInInstructions('Use the Atomic Chatbot API')).toBe(
      'Use the Radiumbot API'
    )
  })
})

describe('renameProductInAssistantName', () => {
  it('renames the shipped default assistant under either former name', () => {
    expect(renameProductInAssistantName('Atomic Chat')).toBe('Radium')
    expect(renameProductInAssistantName('Radium Chat')).toBe('Radium')
  })

  it('keeps any name the user chose, even one that mentions the product', () => {
    expect(renameProductInAssistantName('Writer')).toBe('Writer')
    expect(renameProductInAssistantName('My Atomic Chat helper')).toBe(
      'My Atomic Chat helper'
    )
    expect(renameProductInAssistantName('Radium')).toBe('Radium')
  })

  it('handles an assistant with no name', () => {
    expect(renameProductInAssistantName(undefined)).toBeUndefined()
  })
})
