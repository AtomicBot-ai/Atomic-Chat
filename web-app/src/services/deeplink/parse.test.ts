import { describe, expect, it } from 'vitest'

import { parseAtomicChatDeepLink } from './parse'

describe('parseAtomicChatDeepLink', () => {
  it('parses a Hugging Face model deeplink', () => {
    expect(
      parseAtomicChatDeepLink(
        'atomic-chat://models/huggingface/owner/model-GGUF'
      )
    ).toEqual({
      provider: 'huggingface',
      repo: 'owner/model-GGUF',
      modelId: 'owner/model-GGUF',
    })
  })

  it('rejects non Atomic Chat schemes', () => {
    expect(
      parseAtomicChatDeepLink('jan://models/huggingface/owner/model-GGUF')
    ).toBeNull()
  })

  it('rejects incomplete Hugging Face paths', () => {
    expect(
      parseAtomicChatDeepLink('atomic-chat://models/huggingface/owner')
    ).toBeNull()
  })
})
