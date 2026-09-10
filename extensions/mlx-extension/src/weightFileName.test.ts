import { describe, expect, it } from 'vitest'
import { mlxMainWeightFileName } from './weightFileName'

const HF = 'https://huggingface.co/mlx-community/gemma-4-12B-it-4bit/resolve/main'

describe('mlxMainWeightFileName', () => {
  it('keeps the shard name the safetensors index points at', () => {
    expect(mlxMainWeightFileName(`${HF}/model-00001-of-00002.safetensors`)).toBe(
      'model-00001-of-00002.safetensors'
    )
  })

  it('keeps the single-file name of unsharded checkpoints', () => {
    expect(mlxMainWeightFileName(`${HF}/model.safetensors`)).toBe(
      'model.safetensors'
    )
  })

  it('ignores query strings and fragments', () => {
    expect(
      mlxMainWeightFileName(
        `${HF}/model-00002-of-00002.safetensors?download=true#frag`
      )
    ).toBe('model-00002-of-00002.safetensors')
  })

  it('falls back for URLs that do not name a weight file', () => {
    expect(mlxMainWeightFileName(`${HF}/tokenizer.json`)).toBe(
      'model.safetensors'
    )
    expect(mlxMainWeightFileName(`${HF}/`)).toBe('model.safetensors')
  })

  it('refuses names that could escape the model directory', () => {
    expect(mlxMainWeightFileName(`${HF}/..%2Fevil.safetensors`)).toBe(
      'model.safetensors'
    )
    expect(mlxMainWeightFileName(`${HF}/..safetensors`)).toBe(
      'model.safetensors'
    )
  })
})
