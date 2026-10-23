import { describe, expect, it } from 'vitest'

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { localModelCollisions } from '@/lib/local-model-collisions'

const providers = [
  {
    provider: 'llamacpp',
    models: [{ id: 'qwen' }, { id: EMBEDDING_MODEL_ID }],
  },
  { provider: 'llamacpp-upstream', models: [{ id: 'qwen' }] },
  { provider: 'openai', models: [{ id: 'gpt-5' }] },
]

describe('localModelCollisions', () => {
  it('lists each endpoint id a local engine lists once, with the provider selected for it', () => {
    expect(
      localModelCollisions(['qwen', 'qwen', 'gpt-5', 'other'], providers, [
        { model: 'qwen', provider: 'llamacpp-upstream' },
      ])
    ).toEqual([{ model: 'qwen', served: 'llamacpp-upstream' }])
  })

  it('leaves `served` out when nothing is selected, and ignores the bundled embedder', () => {
    expect(
      localModelCollisions(['qwen', EMBEDDING_MODEL_ID], providers, [])
    ).toEqual([{ model: 'qwen' }])
  })
})
