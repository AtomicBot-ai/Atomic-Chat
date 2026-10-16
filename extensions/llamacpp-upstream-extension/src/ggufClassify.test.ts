import { describe, it, expect } from 'vitest'
import { checkChatModel, nonChatReason, splitPart } from './ggufClassify'

describe('checkChatModel', () => {
  it.each(['llama', 'qwen2', 'qwen3', 'mistral', 'gemma3', 'phi3', 'gpt-oss'])(
    'accepts %s',
    (arch) => {
      expect(
        checkChatModel({
          'general.architecture': arch,
          [`${arch}.context_length`]: '8192',
        })
      ).toEqual({ chat: true })
    }
  )

  it.each(['wan', 'flux', 'qwen_image', 'clip', 't5', 'umt5', 'vae', 'sd3'])(
    'rejects %s',
    (arch) => {
      const r = checkChatModel({
        'general.architecture': arch,
        [`${arch}.context_length`]: '512',
      })
      expect(r.chat).toBe(false)
    }
  )

  it('rejects an unknown arch without a context length (e.g. flux krea)', () => {
    const r = checkChatModel({ 'general.architecture': 'krea' }, 'flux1-krea-dev-Q8_0.gguf')
    expect(r.chat).toBe(false)
  })

  it('rejects mmproj files and missing arch', () => {
    expect(
      checkChatModel(
        { 'general.architecture': 'clip' },
        'mmproj-Qwen2.5-VL-F16.gguf'
      ).chat
    ).toBe(false)
    expect(checkChatModel({}).chat).toBe(false)
  })

  it('explains why', () => {
    expect(nonChatReason('wan')).toMatch(/diffusion/)
    expect(nonChatReason('llama')).toBeUndefined()
  })
})

describe('splitPart', () => {
  it('parses split names', () => {
    expect(splitPart('Qwen3-235B-Q4_K_M-00001-of-00003.gguf')).toEqual([1, 3])
    expect(splitPart('x-00002-of-00002.gguf')).toEqual([2, 2])
    expect(splitPart('model-Q4_K_M.gguf')).toBeUndefined()
    expect(splitPart('x-00004-of-00003.gguf')).toBeUndefined()
  })
})
