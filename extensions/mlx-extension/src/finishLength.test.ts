import { describe, expect, it } from 'vitest'

import { isContextOverflowLength } from './finishLength'

describe('isContextOverflowLength', () => {
  it('reads an answer stopped at its max_tokens as the cap, not the window', () => {
    // mlx-server's default cap with a short prompt in a 16K window (#384).
    expect(
      isContextOverflowLength(
        { prompt_tokens: 40, completion_tokens: 2048 },
        16384
      )
    ).toBe(false)
  })

  it('reads usage that fills the loaded window as a context overflow', () => {
    expect(
      isContextOverflowLength(
        { prompt_tokens: 12000, completion_tokens: 4384 },
        16384
      )
    ).toBe(true)
  })

  it('takes `length` for the cap when usage or the window is unknown', () => {
    expect(isContextOverflowLength(undefined, 16384)).toBe(false)
    expect(isContextOverflowLength({ prompt_tokens: 10 }, 16384)).toBe(false)
    expect(
      isContextOverflowLength(
        { prompt_tokens: 12000, completion_tokens: 4384 },
        undefined
      )
    ).toBe(false)
  })
})
