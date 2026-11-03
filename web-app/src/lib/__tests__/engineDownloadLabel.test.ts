import { describe, expect, it } from 'vitest'

import { engineDownloadLabel } from '@/lib/engineDownloadLabel'

describe('engineDownloadLabel', () => {
  it.each([
    // The llama.cpp extensions' backend installs.
    ['llamacpp-backend-b11463/macos-arm64', 'llama.cpp', 'b11463'],
    ['llamacpp-backend-b6123-macos-arm64', 'llama.cpp', 'b6123'],
    // The core's engine updates, engine ids with a hyphen included.
    ['engine-update-llamacpp-upstream-b11500', 'llama.cpp', 'b11500'],
    ['engine-update-llamacpp-b11500', 'llama.cpp turboquant', 'b11500'],
    ['engine-update-atomic-prism-b10777', 'PrismML llama.cpp', 'b10777'],
    [
      'engine-update-sd-cpp-master-900-abc1234',
      'stable-diffusion.cpp',
      'master-900-abc1234',
    ],
    // The core's engine builds.
    ['engine-build-litert-lm-v0_9_1', 'LiteRT-LM', 'v0_9_1'],
    // The media engine.
    [
      'diffusion-backend-master-883-137f740-a36f1b1a-macos-arm64',
      'stable-diffusion.cpp',
      'master-883-137f740-a36f1b1a',
    ],
  ])('names %s', (id, name, version) => {
    expect(engineDownloadLabel(id)).toEqual({ name, version })
  })

  it('leaves models alone', () => {
    expect(engineDownloadLabel('unsloth/Qwen3-4B-GGUF')).toBeNull()
    expect(engineDownloadLabel('diffusion-model-flux:q4')).toBeNull()
    expect(engineDownloadLabel('engine-update-unknown-1')).toBeNull()
  })
})
