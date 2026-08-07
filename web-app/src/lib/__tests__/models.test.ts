import { describe, it, expect, vi } from 'vitest'
import {
  defaultModel,
  extractDescription,
  removeYamlFrontMatter,
  extractModelName,
  extractModelRepo,
  findCatalogModelForRecommendedRepo,
  getModelCapabilities,
  ggufShardGroupKey,
  groupGgufShards,
  mergeShardedQuants,
} from '../models'
import { ModelCapabilities } from '@/types/models'
import type { CatalogModel } from '@/services/models/types'

// Mock the token.js module
vi.mock('token.js', () => ({
  models: {
    openai: {
      models: ['gpt-5', 'gpt-4'],
      supportsToolCalls: ['gpt-5', 'gpt-4'],
      supportsImages: ['gpt-4-vision-preview'],
    },
    anthropic: {
      models: ['claude-sonnet-4-5', 'claude-3-haiku'],
      supportsToolCalls: ['claude-sonnet-4-5'],
      supportsImages: ['claude-sonnet-4-5', 'claude-3-haiku'],
    },
    mistral: {
      models: ['mistral-7b', 'mistral-8x7b'],
      supportsToolCalls: ['mistral-8x7b'],
    },
    // Provider with no capability arrays
    cohere: {
      models: ['command', 'command-light'],
    },
  },
}))

describe('ggufShardGroupKey', () => {
  it('strips the shard suffix a split quant carries', () => {
    expect(
      ggufShardGroupKey('UD-IQ4_XS/DeepSeek-V4-Flash-UD-IQ4_XS-00002-of-00004.gguf')
    ).toBe('UD-IQ4_XS/DeepSeek-V4-Flash-UD-IQ4_XS.gguf')
  })

  it('leaves a single-file quant alone', () => {
    expect(ggufShardGroupKey('Bonsai-27B-Q1_0.gguf')).toBe('Bonsai-27B-Q1_0.gguf')
  })

  it('keeps a part count that is not a shard suffix', () => {
    // Only the trailing `-NNNNN-of-NNNNN` marks a shard.
    expect(ggufShardGroupKey('model-00001-of-00003-extra.gguf')).toBe(
      'model-00001-of-00003-extra.gguf'
    )
  })
})

describe('groupGgufShards', () => {
  it('collects every shard of a quant into one group', () => {
    const groups = groupGgufShards([
      { rfilename: 'UD-Q2_K_XL/Kimi-K3-UD-Q2_K_XL-00001-of-00003.gguf' },
      { rfilename: 'UD-IQ1_M/Kimi-K3-UD-IQ1_M-00001-of-00002.gguf' },
      { rfilename: 'UD-Q2_K_XL/Kimi-K3-UD-Q2_K_XL-00002-of-00003.gguf' },
      { rfilename: 'UD-IQ1_M/Kimi-K3-UD-IQ1_M-00002-of-00002.gguf' },
      { rfilename: 'UD-Q2_K_XL/Kimi-K3-UD-Q2_K_XL-00003-of-00003.gguf' },
    ])

    expect(groups.map((group) => group.length)).toEqual([3, 2])
  })

  it('opens each group with the shard a download has to start from', () => {
    const [group] = groupGgufShards([
      { rfilename: 'model-00003-of-00003.gguf' },
      { rfilename: 'model-00001-of-00003.gguf' },
      { rfilename: 'model-00002-of-00003.gguf' },
    ])

    expect(group[0].rfilename).toBe('model-00001-of-00003.gguf')
  })

  it('keeps unsharded files as groups of their own', () => {
    const groups = groupGgufShards([
      { rfilename: 'Bonsai-27B-F16.gguf' },
      { rfilename: 'Bonsai-27B-Q1_0.gguf' },
    ])

    expect(groups).toEqual([
      [{ rfilename: 'Bonsai-27B-F16.gguf' }],
      [{ rfilename: 'Bonsai-27B-Q1_0.gguf' }],
    ])
  })
})

describe('mergeShardedQuants', () => {
  // Shape taken from the published catalog entry for unsloth/Kimi-K3-GGUF.
  const shardedEntry = () =>
    ({
      num_quants: 4,
      quants: [
        {
          model_id: 'unsloth/UD-IQ1_M/Kimi-K3-UD-IQ1_M-00001-of-00003',
          path: 'https://huggingface.co/unsloth/Kimi-K3-GGUF/resolve/main/UD-IQ1_M/Kimi-K3-UD-IQ1_M-00001-of-00003.gguf',
          file_size: '6.6 MB',
        },
        {
          model_id: 'unsloth/UD-IQ1_M/Kimi-K3-UD-IQ1_M-00002-of-00003',
          path: 'https://huggingface.co/unsloth/Kimi-K3-GGUF/resolve/main/UD-IQ1_M/Kimi-K3-UD-IQ1_M-00002-of-00003.gguf',
          file_size: '45.0 GB',
        },
        {
          model_id: 'unsloth/UD-IQ1_M/Kimi-K3-UD-IQ1_M-00003-of-00003',
          path: 'https://huggingface.co/unsloth/Kimi-K3-GGUF/resolve/main/UD-IQ1_M/Kimi-K3-UD-IQ1_M-00003-of-00003.gguf',
          file_size: '45.0 GB',
        },
        {
          model_id: 'unsloth/UD-TQ1_0/Kimi-K3-UD-TQ1_0',
          path: 'https://huggingface.co/unsloth/Kimi-K3-GGUF/resolve/main/UD-TQ1_0/Kimi-K3-UD-TQ1_0.gguf',
          file_size: '12.0 GB',
        },
      ],
    }) as CatalogModel

  it('turns a shard set into a single variant', () => {
    const merged = mergeShardedQuants(shardedEntry())

    expect(merged.num_quants).toBe(2)
    expect(merged.quants.map((quant) => quant.model_id)).toEqual([
      'unsloth/UD-IQ1_M/Kimi-K3-UD-IQ1_M',
      'unsloth/UD-TQ1_0/Kimi-K3-UD-TQ1_0',
    ])
  })

  it('quotes the whole set rather than its header shard', () => {
    const merged = mergeShardedQuants(shardedEntry())

    expect(merged.quants[0].file_size).toBe('90.0 GB')
  })

  it('leaves the download pointing at the first shard', () => {
    const merged = mergeShardedQuants(shardedEntry())

    expect(merged.quants[0].path).toContain('00001-of-00003.gguf')
  })

  it('returns an unsharded entry untouched', () => {
    const flat = {
      num_quants: 1,
      quants: [
        {
          model_id: 'prism-ml/Bonsai-27B-Q1_0',
          path: 'https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/main/Bonsai-27B-Q1_0.gguf',
          file_size: '3.5 GB',
        },
      ],
    } as CatalogModel

    expect(mergeShardedQuants(flat)).toBe(flat)
  })

  it('survives an entry with no quants', () => {
    const empty = { num_quants: 0, quants: [] } as unknown as CatalogModel

    expect(mergeShardedQuants(empty)).toBe(empty)
  })
})

describe('defaultModel', () => {
  it('returns first OpenAI model when no provider is given', () => {
    expect(defaultModel()).toBe('gpt-5.4')
  })

  it('returns first OpenAI model when unknown provider is given', () => {
    expect(defaultModel('unknown')).toBe('gpt-5.4')
  })

  it('returns first model for known providers', () => {
    expect(defaultModel('anthropic')).toBe('claude-opus-4-7')
    expect(defaultModel('mistral')).toBe('mistral-large-2411')
  })

  it('handles empty string provider', () => {
    expect(defaultModel('')).toBe('gpt-5.4')
  })
})

describe('extractDescription', () => {
  it('returns undefined for falsy input', () => {
    expect(extractDescription()).toBeUndefined()
    expect(extractDescription('')).toBe('')
  })

  it('extracts overview section from markdown', () => {
    const markdown = `# Model Title
## Overview
This is the model overview section.
It has multiple lines.
## Features
This is another section.`

    expect(extractDescription(markdown)).toBe(
      'This is the model overview section.\nIt has multiple lines.'
    )
  })

  it('falls back to first 500 characters when no overview section', () => {
    const longText = 'A'.repeat(600)
    expect(extractDescription(longText)).toBe('A'.repeat(500))
  })

  it('removes YAML front matter before extraction', () => {
    const markdownWithYaml = `---
title: Model
author: Test
---
# Model Title
## Overview
This is the overview.`

    expect(extractDescription(markdownWithYaml)).toBe('This is the overview.')
  })

  it('removes image markdown syntax', () => {
    const markdownWithImages = `## Overview
This is text with ![alt text](image.png) image.
More text here.`

    expect(extractDescription(markdownWithImages)).toBe(
      'This is text with  image.\nMore text here.'
    )
  })

  it('removes HTML img tags', () => {
    const markdownWithHtmlImages = `## Overview
This is text with <img src="image.png" alt="alt"> image.
More text here.`

    expect(extractDescription(markdownWithHtmlImages)).toBe(
      'This is text with  image.\nMore text here.'
    )
  })

  it('handles text without overview section', () => {
    const simpleText = 'This is a simple description without sections.'
    expect(extractDescription(simpleText)).toBe(
      'This is a simple description without sections.'
    )
  })

  it('extracts overview that ends at file end', () => {
    const markdown = `# Model Title
## Overview
This is the overview at the end.`

    expect(extractDescription(markdown)).toBe(
      'This is the overview at the end.'
    )
  })
})

describe('removeYamlFrontMatter', () => {
  it('removes YAML front matter from content', () => {
    const contentWithYaml = `---
title: Test
author: John
---
# Main Content
This is the main content.`

    const expected = `# Main Content
This is the main content.`

    expect(removeYamlFrontMatter(contentWithYaml)).toBe(expected)
  })

  it('returns content unchanged when no YAML front matter', () => {
    const content = `# Main Content
This is the main content.`

    expect(removeYamlFrontMatter(content)).toBe(content)
  })

  it('handles empty content', () => {
    expect(removeYamlFrontMatter('')).toBe('')
  })

  it('handles content with only YAML front matter', () => {
    const yamlOnly = `---
title: Test
author: John
---
`

    expect(removeYamlFrontMatter(yamlOnly)).toBe('')
  })

  it('does not remove YAML-like content in middle of text', () => {
    const content = `# Title
Some content here.
---
This is not front matter
---
More content.`

    expect(removeYamlFrontMatter(content)).toBe(content)
  })
})

describe('extractModelName', () => {
  it('extracts model name from repo path', () => {
    expect(extractModelName('cortexso/tinyllama')).toBe('tinyllama')
    expect(extractModelName('microsoft/DialoGPT-medium')).toBe(
      'DialoGPT-medium'
    )
    expect(extractModelName('huggingface/CodeBERTa-small-v1')).toBe(
      'CodeBERTa-small-v1'
    )
  })

  it('returns the input when no slash is present', () => {
    expect(extractModelName('tinyllama')).toBe('tinyllama')
    expect(extractModelName('single-model-name')).toBe('single-model-name')
  })

  it('handles undefined input', () => {
    expect(extractModelName()).toBeUndefined()
  })

  it('handles empty string', () => {
    expect(extractModelName('')).toBe('')
  })

  it('handles multiple slashes', () => {
    expect(extractModelName('org/sub/model')).toBe('sub')
  })
})

describe('extractModelRepo', () => {
  it('extracts repo path from HuggingFace URL', () => {
    expect(extractModelRepo('https://huggingface.co/cortexso/tinyllama')).toBe(
      'cortexso/tinyllama'
    )
    expect(
      extractModelRepo('https://huggingface.co/microsoft/DialoGPT-medium')
    ).toBe('microsoft/DialoGPT-medium')
  })

  it('returns input unchanged when not a HuggingFace URL', () => {
    expect(extractModelRepo('cortexso/tinyllama')).toBe('cortexso/tinyllama')
    expect(extractModelRepo('https://github.com/user/repo')).toBe(
      'https://github.com/user/repo'
    )
  })

  it('handles undefined input', () => {
    expect(extractModelRepo()).toBeUndefined()
  })

  it('handles empty string', () => {
    expect(extractModelRepo('')).toBe('')
  })

  it('handles URLs with trailing slashes', () => {
    expect(extractModelRepo('https://huggingface.co/cortexso/tinyllama/')).toBe(
      'cortexso/tinyllama/'
    )
  })
})

describe('getModelCapabilities', () => {
  it('returns completion capability for all models', () => {
    const capabilities = getModelCapabilities('openai', 'gpt-5.4')
    expect(capabilities).toContain(ModelCapabilities.COMPLETION)
  })

  it('includes tools capability when model supports it', () => {
    const capabilities = getModelCapabilities('openai', 'gpt-5.4')
    expect(capabilities).toContain(ModelCapabilities.TOOLS)
    expect(capabilities).toContain(ModelCapabilities.COMPLETION)
  })

  it('excludes tools capability when model does not support it', () => {
    const capabilities = getModelCapabilities('mistral', 'mistral-nemo-2407')
    expect(capabilities).not.toContain(ModelCapabilities.TOOLS)
    expect(capabilities).toContain(ModelCapabilities.COMPLETION)
  })

  it('includes vision capability when model supports it', () => {
    const capabilities = getModelCapabilities('openai', 'gpt-5.4')
    expect(capabilities).toContain(ModelCapabilities.VISION)
    expect(capabilities).toContain(ModelCapabilities.COMPLETION)
  })

  it('excludes vision capability when model does not support it', () => {
    const capabilities = getModelCapabilities('openai', 'gpt-4')
    expect(capabilities).not.toContain(ModelCapabilities.VISION)
  })

  it('includes both tools and vision when model supports both', () => {
    const capabilities = getModelCapabilities('anthropic', 'claude-sonnet-4-5')
    expect(capabilities).toContain(ModelCapabilities.COMPLETION)
    expect(capabilities).toContain(ModelCapabilities.TOOLS)
    expect(capabilities).toContain(ModelCapabilities.VISION)
  })

  it('handles provider with no capability arrays gracefully', () => {
    const capabilities = getModelCapabilities('ai21', 'jamba-instruct')
    expect(capabilities).toEqual([ModelCapabilities.COMPLETION])
    expect(capabilities).not.toContain(ModelCapabilities.TOOLS)
    expect(capabilities).not.toContain(ModelCapabilities.VISION)
  })

  it('handles unknown provider gracefully', () => {
    const capabilities = getModelCapabilities('openrouter', 'some-model')
    expect(capabilities).toEqual([ModelCapabilities.COMPLETION])
    expect(capabilities).not.toContain(ModelCapabilities.TOOLS)
    expect(capabilities).not.toContain(ModelCapabilities.VISION)
  })

  it('handles model not in capability list', () => {
    const capabilities = getModelCapabilities('xai', 'grok-2-vision-1212')
    expect(capabilities).toContain(ModelCapabilities.COMPLETION)
    expect(capabilities).toContain(ModelCapabilities.VISION)
    expect(capabilities).not.toContain(ModelCapabilities.TOOLS)
  })

  it('returns only completion for provider with partial capability data', () => {
    // Mistral has supportsToolCalls but no supportsImages
    const capabilities = getModelCapabilities('mistral', 'mistral-nemo-2407')
    expect(capabilities).toEqual([ModelCapabilities.COMPLETION])
  })

  it('handles model that supports tools but not vision', () => {
    const capabilities = getModelCapabilities('mistral', 'mistral-large-2411')
    expect(capabilities).toContain(ModelCapabilities.COMPLETION)
    expect(capabilities).toContain(ModelCapabilities.TOOLS)
    expect(capabilities).not.toContain(ModelCapabilities.VISION)
  })
})

describe('findCatalogModelForRecommendedRepo', () => {
  const make = (model_name: string): CatalogModel =>
    ({ model_name, developer: model_name.split('/')[0] }) as CatalogModel

  it('returns the exact repo match (case-sensitive equality)', () => {
    const sources = [
      make('unsloth/gemma-4-E4B-it-GGUF'),
      make('lmstudio-community/gemma-4-E4B-it-GGUF'),
      make('ggml-org/gemma-4-E4B-it-GGUF'),
    ]
    const result = findCatalogModelForRecommendedRepo(
      sources,
      'unsloth/gemma-4-E4B-it-GGUF'
    )
    expect(result?.model_name).toBe('unsloth/gemma-4-E4B-it-GGUF')
  })

  it('matches case-insensitively on the full org/repo path', () => {
    const sources = [make('mlx-community/Gemma-4-31b-It-4bit')]
    const result = findCatalogModelForRecommendedRepo(
      sources,
      'MLX-Community/gemma-4-31b-it-4bit'
    )
    expect(result?.model_name).toBe('mlx-community/Gemma-4-31b-It-4bit')
  })

  it('does NOT fall back to tail-only matching across orgs (regression)', () => {
    //* Bug: «recommended unsloth/X» молча резолвился в lmstudio-community/X
    //* потому что tail совпадал. После фикса — undefined.
    const sources = [
      make('lmstudio-community/gemma-4-E4B-it-GGUF'),
      make('ggml-org/gemma-4-E4B-it-GGUF'),
    ]
    const result = findCatalogModelForRecommendedRepo(
      sources,
      'unsloth/gemma-4-E4B-it-GGUF'
    )
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty input', () => {
    expect(findCatalogModelForRecommendedRepo([], 'foo/bar')).toBeUndefined()
    expect(
      findCatalogModelForRecommendedRepo([make('foo/bar')], '')
    ).toBeUndefined()
  })
})
