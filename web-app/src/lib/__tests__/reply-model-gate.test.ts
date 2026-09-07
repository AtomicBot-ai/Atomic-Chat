import { describe, expect, it } from 'vitest'

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import {
  collectReplyModels,
  replyGateBranch,
  replyGateContext,
} from '@/lib/reply-model-gate'

const model = (id: string, extra: Partial<Model> = {}): Model =>
  ({ id, ...extra }) as Model

const provider = (
  name: string,
  models: Model[],
  extra: Partial<ModelProvider> = {}
): ModelProvider =>
  ({
    provider: name,
    active: true,
    models,
    settings: [],
    ...extra,
  }) as ModelProvider

const local = (models: Model[], extra: Partial<ModelProvider> = {}) =>
  provider('llamacpp-upstream', models, extra)

/** A cloud provider counts as connected once it holds an API key. */
const cloud = (
  name: string,
  models: Model[],
  extra: Partial<ModelProvider> = {}
) =>
  provider(name, models, {
    api_key: 'sk-test',
    settings: [
      {
        key: 'api-key',
        title: 'API key',
        description: '',
        controller_type: 'input',
        controller_props: { value: 'sk-test' },
      },
    ],
    ...extra,
  })

describe('collectReplyModels', () => {
  it('lists loadable local models with their provider', () => {
    const options = collectReplyModels([local([model('Qwen3.5-4B-Q4_K_M')])])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      kind: 'local',
      providerName: 'llamacpp-upstream',
      modelId: 'Qwen3.5-4B-Q4_K_M',
    })
    expect(options[0].label).toBe('Qwen3.5 4B')
  })

  it('skips what cannot answer: broken links, embeddings, dead providers', () => {
    const options = collectReplyModels([
      local([
        model('gone', { missing: true }),
        model(EMBEDDING_MODEL_ID),
        model('fine'),
      ]),
      provider('mlx', [model('disabled-provider-model')], { active: false }),
    ])

    expect(options.map((o) => o.modelId)).toEqual(['fine'])
  })

  it('qualifies the key by provider, so the same GGUF in two engines is two rows', () => {
    const options = collectReplyModels([
      provider('llamacpp-upstream', [model('shared.gguf')]),
      provider('llamacpp', [model('shared.gguf')]),
    ])

    expect(new Set(options.map((o) => o.key)).size).toBe(2)
  })

  it('collapses a connected cloud provider to one row, not its whole catalogue', () => {
    const options = collectReplyModels([
      cloud('openai', [model('gpt-a'), model('gpt-b'), model('gpt-c')]),
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      kind: 'cloud',
      providerName: 'openai',
      modelId: 'gpt-a',
    })
  })

  it("carries the cloud provider's last used model on its row", () => {
    const options = collectReplyModels(
      [cloud('openai', [model('gpt-a'), model('gpt-b')])],
      { provider: 'openai', model: 'gpt-b' }
    )

    expect(options[0].modelId).toBe('gpt-b')
  })

  it('ignores a cloud provider the user never connected', () => {
    const options = collectReplyModels([provider('openai', [model('gpt-a')])])

    expect(options).toEqual([])
  })

  it('puts the last used model first', () => {
    const options = collectReplyModels(
      [local([model('first'), model('second'), model('third')])],
      { provider: 'llamacpp-upstream', model: 'third' }
    )

    expect(options.map((o) => o.modelId)).toEqual(['third', 'first', 'second'])
  })

  it('leaves the order alone when the last used model is gone', () => {
    const options = collectReplyModels([local([model('a'), model('b')])], {
      provider: 'llamacpp-upstream',
      model: 'deleted',
    })

    expect(options.map((o) => o.modelId)).toEqual(['a', 'b'])
  })

  it('offers local models before cloud ones', () => {
    const options = collectReplyModels([
      cloud('openai', [model('gpt-a')]),
      local([model('local-a')]),
    ])

    expect(options.map((o) => o.kind)).toEqual(['local', 'cloud'])
  })
})

describe('replyGateBranch', () => {
  it('recommends a download when the device has nothing', () => {
    expect(replyGateBranch([])).toBe('none')
  })

  it('starts the only option rather than asking a one-answer question', () => {
    expect(replyGateBranch(collectReplyModels([local([model('only')])]))).toBe(
      'auto_start'
    )
  })

  it('asks when there is a real choice', () => {
    expect(
      replyGateBranch(collectReplyModels([local([model('a'), model('b')])]))
    ).toBe('pick')
  })
})

describe('replyGateContext', () => {
  it('counts local models and connected cloud providers separately', () => {
    const context = replyGateContext([
      local([model('a'), model('b'), model(EMBEDDING_MODEL_ID)]),
      cloud('openai', [model('gpt-a'), model('gpt-b')]),
      provider('anthropic', [model('claude')]),
    ])

    expect(context).toEqual({
      localModelCount: 2,
      // The unconnected provider does not count; the connected one counts once
      // however many models it lists.
      cloudProviderCount: 1,
      hasCloudConnection: true,
    })
  })

  it('reports no cloud connection when nothing is configured', () => {
    expect(replyGateContext([local([model('a')])])).toMatchObject({
      cloudProviderCount: 0,
      hasCloudConnection: false,
    })
  })
})
