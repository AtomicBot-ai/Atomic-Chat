import { afterEach, describe, expect, it, vi } from 'vitest'

import { getBaselineEmbeddingCatalog } from '@/services/embedding-catalog-registry'

import {
  EMBEDDING_ENGINE,
  EMBEDDING_ENGINE_UI,
  embeddingEngineReadiness,
  isEmbeddingHostSupported,
} from '../engine'

const byId = (id: string) =>
  getBaselineEmbeddingCatalog().models.find((model) => model.id === id)!

const onHost = (os: 'macos' | 'windows' | 'linux') => {
  vi.stubGlobal('IS_MACOS', os === 'macos')
  vi.stubGlobal('IS_WINDOWS', os === 'windows')
  vi.stubGlobal('IS_LINUX', os === 'linux')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embeddingEngineReadiness', () => {
  it('asks for the build a model needs when the configured one is older', () => {
    expect(
      embeddingEngineReadiness(byId('embeddinggemma-2'), 'b11443/macos-arm64')
    ).toEqual({ kind: 'needs_update', required: 'b11454' })
    expect(
      embeddingEngineReadiness(byId('bge-m3'), 'b11370/win-cuda-12.4-x64')
    ).toEqual({ kind: 'needs_update', required: 'b11443' })
  })

  it('is ready at the floor or past it, and leaves an unknown build to the core', () => {
    expect(
      embeddingEngineReadiness(byId('embeddinggemma-2'), 'b11454/macos-arm64')
        .kind
    ).toBe('ready')
    expect(
      embeddingEngineReadiness(byId('bge-m3'), 'b11463/linux-vulkan-x64').kind
    ).toBe('ready')
    expect(embeddingEngineReadiness(byId('bge-m3'), undefined).kind).toBe(
      'ready'
    )
    expect(
      embeddingEngineReadiness(byId('bge-m3'), 'b10269-1.7.0/macos-arm64').kind
    ).toBe('ready')
  })

  it('runs on stock llama.cpp with its default updater', () => {
    expect(EMBEDDING_ENGINE).toBe('llamacpp-upstream')
    expect(EMBEDDING_ENGINE_UI).toEqual({ updater: {}, name: 'llama.cpp' })
  })
})

describe('isEmbeddingHostSupported', () => {
  it('runs where stock llama.cpp has a build', () => {
    onHost('macos')
    expect(isEmbeddingHostSupported('aarch64')).toBe(true)
    expect(isEmbeddingHostSupported('x86_64')).toBe(false)
    onHost('windows')
    expect(isEmbeddingHostSupported('x86_64')).toBe(true)
    expect(isEmbeddingHostSupported('aarch64')).toBe(true)
    onHost('linux')
    expect(isEmbeddingHostSupported('x86_64')).toBe(true)
    expect(isEmbeddingHostSupported('aarch64')).toBe(false)
  })

  it('counts an arch not reported yet as supported', () => {
    onHost('macos')
    expect(isEmbeddingHostSupported(undefined)).toBe(true)
  })
})
