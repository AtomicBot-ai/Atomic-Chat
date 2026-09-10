import { describe, expect, it } from 'vitest'
import { planMlxShardRepair, repointLegacyWeightPath } from './shardRepair'

const SHARD_1 = 'model-00001-of-00002.safetensors'
const SHARD_2 = 'model-00002-of-00002.safetensors'

const weightMap = {
  'language_model.model.embed_tokens.weight': SHARD_1,
  'language_model.model.layers.0.self_attn.q_proj.weight': SHARD_1,
  'vision_tower.embeddings.weight': SHARD_2,
}

const otherFiles = ['config.json', 'model.safetensors.index.json']

describe('planMlxShardRepair', () => {
  it('claims the legacy file for the single absent shard', () => {
    expect(
      planMlxShardRepair(weightMap, [
        ...otherFiles,
        'model.safetensors',
        SHARD_2,
      ])
    ).toEqual({ from: 'model.safetensors', to: SHARD_1 })
  })

  it('leaves an intact checkpoint alone', () => {
    expect(
      planMlxShardRepair(weightMap, [...otherFiles, SHARD_1, SHARD_2])
    ).toBeUndefined()
  })

  it('leaves an interrupted download alone', () => {
    expect(
      planMlxShardRepair(weightMap, [...otherFiles, 'model.safetensors'])
    ).toBeUndefined()
  })

  it('does nothing without the legacy file', () => {
    expect(
      planMlxShardRepair(weightMap, [...otherFiles, SHARD_2])
    ).toBeUndefined()
  })

  it('does not touch a checkpoint whose index names the legacy file', () => {
    expect(
      planMlxShardRepair(
        { 'a.weight': 'model.safetensors', 'b.weight': SHARD_2 },
        [...otherFiles, 'model.safetensors']
      )
    ).toBeUndefined()
  })

  it('repairs a single-shard index too', () => {
    expect(
      planMlxShardRepair({ 'a.weight': 'model-00001-of-00001.safetensors' }, [
        ...otherFiles,
        'model.safetensors',
      ])
    ).toEqual({
      from: 'model.safetensors',
      to: 'model-00001-of-00001.safetensors',
    })
  })

  it('tolerates a malformed index', () => {
    expect(planMlxShardRepair(undefined, ['model.safetensors'])).toBeUndefined()
    expect(
      planMlxShardRepair('nonsense', ['model.safetensors'])
    ).toBeUndefined()
    expect(
      planMlxShardRepair({ 'a.weight': 42 }, ['model.safetensors'])
    ).toBeUndefined()
  })
})

describe('repointLegacyWeightPath', () => {
  it('rewrites a path that still names the legacy file', () => {
    expect(
      repointLegacyWeightPath('mlx/models/gemma/model.safetensors', SHARD_1)
    ).toBe(`mlx/models/gemma/${SHARD_1}`)
  })

  it('rewrites Windows-separated paths', () => {
    expect(
      repointLegacyWeightPath(
        'C:\\data\\mlx\\gemma\\model.safetensors',
        SHARD_1
      )
    ).toBe(`C:\\data\\mlx\\gemma\\${SHARD_1}`)
  })

  it('leaves other paths untouched', () => {
    expect(repointLegacyWeightPath('mlx/models/gemma', SHARD_1)).toBe(
      'mlx/models/gemma'
    )
    expect(
      repointLegacyWeightPath(`mlx/models/gemma/${SHARD_2}`, SHARD_1)
    ).toBe(`mlx/models/gemma/${SHARD_2}`)
    expect(repointLegacyWeightPath('model.safetensors', SHARD_1)).toBe(
      'model.safetensors'
    )
  })
})
