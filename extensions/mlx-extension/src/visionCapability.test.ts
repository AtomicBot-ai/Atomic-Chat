import { describe, expect, it } from 'vitest'
import {
  classifyMlxVisionCapability,
  isMultimodalWeight,
} from './visionCapability'

describe('classifyMlxVisionCapability', () => {
  it('rejects VLM-like metadata without vision config', () => {
    expect(
      classifyMlxVisionCapability({
        architectures: ['OrnithForConditionalGeneration'],
        visual_architectures: ['SiglipVisionModel'],
        image_token_id: 248056,
        text_config: { model_type: 'qwen3_5_moe' },
      })
    ).toBe(false)
  })

  it('accepts vision config when no safetensors index is available', () => {
    expect(
      classifyMlxVisionCapability({
        model_type: 'qwen3_5',
        vision_config: { hidden_size: 1024 },
      })
    ).toBe(true)
  })

  it('rejects wrapper config whose indexed weights are text-only', () => {
    expect(
      classifyMlxVisionCapability(
        {
          model_type: 'qwen3_5',
          text_config: { model_type: 'qwen3_5_moe' },
          vision_config: { hidden_size: 1024 },
        },
        {
          weight_map: {
            'language_model.model.embed_tokens.weight':
              'model-00001-of-00002.safetensors',
          },
        }
      )
    ).toBe(false)
  })

  it('accepts indexed checkpoints with embodied vision weights', () => {
    expect(
      classifyMlxVisionCapability(
        { vision_config: { hidden_size: 1024 } },
        {
          weight_map: {
            'model.vision_tower.blocks.0.attn.q_proj.weight':
              'model-00001-of-00002.safetensors',
          },
        }
      )
    ).toBe(true)
  })

  it('rejects malformed safetensors indexes conservatively', () => {
    expect(
      classifyMlxVisionCapability(
        { vision_config: { hidden_size: 1024 } },
        { metadata: {} }
      )
    ).toBe(false)
  })
})

describe('isMultimodalWeight', () => {
  it('recognizes projector and visual weight names', () => {
    expect(isMultimodalWeight('model.mm_projector.0.weight')).toBe(true)
    expect(isMultimodalWeight('model.visual.blocks.0.weight')).toBe(true)
  })

  it('does not classify language weights as multimodal', () => {
    expect(
      isMultimodalWeight('language_model.model.layers.0.self_attn.q_proj.weight')
    ).toBe(false)
  })
})
