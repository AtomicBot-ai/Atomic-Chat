import { describe, expect, it, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import {
  countByTier,
  detectRuntimes,
  detectionName,
  filterRuntimes,
  formatCount,
  listRuntimes,
  type RuntimeDescriptor,
  type RuntimeDetection,
} from '../runtimes'

function runtime(partial: Partial<RuntimeDescriptor> & Pick<RuntimeDescriptor, 'id' | 'name' | 'tier'>): RuntimeDescriptor {
  return {
    group: 'local_desktop',
    mode: 'attach',
    layer: 'engine',
    wraps: [],
    capabilities: ['chat'],
    formats: ['gguf'],
    apis: ['open_ai_compatible'],
    default_port: null,
    platforms: { windows: 'native', linux: 'native', macos: 'native' },
    multi_gpu: 'layer_split',
    telemetry: [],
    granularity: 'per_request',
    license: { spdx: 'MIT', class: 'permissive' },
    maintenance: 'active',
    note: '',
    verified: true,
    verified_on: '2026-09-24',
    source_url: 'https://example.com',
    ...partial,
  }
}

const catalog = [
  runtime({ id: 'vllm', name: 'vLLM', tier: 'p2', formats: ['safetensors', 'awq'] }),
  runtime({ id: 'ollama', name: 'Ollama', tier: 'p0' }),
  runtime({ id: 'llama-cpp', name: 'llama.cpp', tier: 'p0' }),
  runtime({ id: 'piper', name: 'Piper', tier: 'p0', capabilities: ['text_to_speech'], formats: ['onnx'] }),
  runtime({ id: 'mlx-lm', name: 'MLX LM', tier: 'out_of_scope' }),
]

function detection(partial: Partial<RuntimeDetection>): RuntimeDetection {
  return {
    baseUrl: 'http://127.0.0.1:8000',
    runtimeId: null,
    confidence: 'port_guess',
    alternatives: [],
    version: null,
    models: [],
    loadedModels: [],
    devices: [],
    counters: null,
    ...partial,
  }
}

describe('runtimes service', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('returns the catalog and the scan the desktop side sends back', async () => {
    const found = [detection({ runtimeId: 'ollama', confidence: 'confirmed' })]
    invoke.mockImplementation(async (command: string) =>
      command === 'runtimes_catalog' ? catalog : found
    )
    expect(await listRuntimes()).toEqual(catalog)
    expect(await detectRuntimes(['http://box:11434'])).toEqual(found)
    // Extra addresses travel as the endpoint objects the Rust command takes.
    expect(invoke).toHaveBeenLastCalledWith('runtimes_detect', {
      endpoints: [{ baseUrl: 'http://box:11434' }],
    })
  })

  it('passes a scan error through for the page to show', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('"ftp://x" must start with http:// or https://')
    })
    await expect(detectRuntimes(['ftp://x'])).rejects.toThrow('must start with http://')
  })

  it('sorts by phase, then by name', () => {
    expect(filterRuntimes(catalog, { tier: 'all', query: '' }).map((r) => r.id)).toEqual([
      'llama-cpp',
      'ollama',
      'piper',
      'vllm',
      'mlx-lm',
    ])
  })

  it('filters by phase and by name, format or capability', () => {
    expect(filterRuntimes(catalog, { tier: 'p2', query: '' }).map((r) => r.id)).toEqual(['vllm'])
    expect(filterRuntimes(catalog, { tier: 'all', query: 'AWQ' }).map((r) => r.id)).toEqual(['vllm'])
    expect(filterRuntimes(catalog, { tier: 'all', query: 'speech' }).map((r) => r.id)).toEqual(['piper'])
    expect(filterRuntimes(catalog, { tier: 'p0', query: 'olla' }).map((r) => r.id)).toEqual(['ollama'])
  })

  it('counts every phase, including empty ones', () => {
    expect(countByTier(catalog)).toEqual({
      p0: 3,
      p1: 0,
      p2: 1,
      p3: 0,
      deferred: 0,
      out_of_scope: 1,
    })
  })

  it('names a detection from the catalog, or lists the candidates for a guessed port', () => {
    const byId = new Map(catalog.map((r) => [r.id, r]))
    expect(detectionName(detection({ runtimeId: 'ollama', confidence: 'confirmed' }), byId)).toBe('Ollama')
    expect(detectionName(detection({ alternatives: ['vllm', 'llama-cpp'] }), byId)).toBe(
      'vLLM or llama.cpp'
    )
    expect(detectionName(detection({}), byId)).toBe('OpenAI-compatible server')
  })

  it('formats counters compactly and hides missing ones', () => {
    expect(formatCount(null)).toBeNull()
    expect(formatCount(undefined)).toBeNull()
    expect(formatCount(Number.NaN)).toBeNull()
    expect(formatCount(345)).toBe('345')
    expect(formatCount(1234)).toBe('1.2k')
    expect(formatCount(2_500_000)).toBe('2.5M')
  })
})
