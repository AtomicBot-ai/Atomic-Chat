import { describe, expect, it, vi, beforeEach } from 'vitest'

const invoke = vi.fn()
const listeners = new Map<string, (event: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  },
}))

import {
  changedKeys,
  coerceSetting,
  describePull,
  formatBytes,
  ollama,
  ollamaSettingFields,
  type OllamaSettings,
} from '../ollama'

const defaults: OllamaSettings = {
  port: 11434,
  allowNetwork: false,
  modelsDir: '',
  contextLength: 0,
  keepAlive: '5m',
  flashAttention: false,
  kvCacheType: 'f16',
  numParallel: 0,
  maxLoadedModels: 0,
  gpus: '',
  spreadAcrossGpus: false,
  gpuOverheadMib: 0,
  noCloud: false,
  autoStart: false,
  extraEnv: '',
}

describe('ollama settings form', () => {
  it('covers every setting exactly once', () => {
    const keys = ollamaSettingFields([]).map((field) => field.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(Object.keys(defaults).sort())
  })

  it('keeps the everyday settings up front and the rest under Advanced', () => {
    const basic = ollamaSettingFields([])
      .filter((field) => !field.advanced)
      .map((field) => field.key)
    expect(basic).toEqual(['contextLength', 'keepAlive', 'gpus', 'flashAttention', 'autoStart'])
  })

  it('lists each GPU by name for the GPU choice, with All GPUs first', () => {
    const gpu = ollamaSettingFields([
      { uuid: 'aaa', name: 'NVIDIA GeForce RTX 3090' },
      { uuid: 'bbb', name: 'NVIDIA GeForce RTX 3090' },
    ]).find((field) => field.key === 'gpus')!
    expect(gpu.options).toEqual([
      { value: '', name: 'All GPUs' },
      { value: 'aaa', name: 'GPU 0: NVIDIA GeForce RTX 3090' },
      { value: 'bbb', name: 'GPU 1: NVIDIA GeForce RTX 3090' },
    ])
  })

  it('turns control values back into the setting type', () => {
    const fields = Object.fromEntries(ollamaSettingFields([]).map((f) => [f.key, f]))
    expect(coerceSetting(fields.contextLength, '8192')).toBe(8192)
    expect(coerceSetting(fields.contextLength, 'abc')).toBe(0)
    expect(coerceSetting(fields.contextLength, '-5')).toBe(0)
    expect(coerceSetting(fields.flashAttention, 1 as unknown as boolean)).toBe(true)
    expect(coerceSetting(fields.keepAlive, '30m')).toBe('30m')
  })

  it('reports which settings changed', () => {
    expect(changedKeys(defaults, { ...defaults })).toEqual([])
    expect(changedKeys(defaults, { ...defaults, contextLength: 8192, autoStart: true })).toEqual([
      'contextLength',
      'autoStart',
    ])
  })
})

describe('ollama helpers', () => {
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(5_200_000_000)).toBe('4.8 GB')
    expect(formatBytes(1_460_000_000)).toBe('1.4 GB')
  })

  it('describes pull progress with a percentage when Ollama gives sizes', () => {
    expect(describePull({ status: 'pulling manifest', completed: null, total: null, done: false })).toEqual({
      label: 'pulling manifest',
      percent: null,
    })
    expect(
      describePull({
        status: 'pulling 1a2b3c4d5e6f7a8b9c0d',
        completed: 500,
        total: 2000,
        done: false,
      })
    ).toEqual({ label: 'downloading 1a2b3c4d5e6f', percent: 25 })
  })
})

describe('ollama commands', () => {
  beforeEach(() => {
    invoke.mockReset()
    listeners.clear()
  })

  it('reports install progress from the download events and stops listening after', async () => {
    const seen: Array<[number, number]> = []
    invoke.mockImplementation(async (command: string) => {
      if (command === 'ollama_install') {
        listeners.get('download-t1')?.({ payload: { transferred: 10, total: 100 } })
        listeners.get('download-t1')?.({ payload: { transferred: 100, total: 100 } })
        return { path: 'C:/ollama.exe', source: 'radium' }
      }
    })
    const binary = await ollama.install('t1', (received, total) => seen.push([received, total]))
    expect(binary).toEqual({ path: 'C:/ollama.exe', source: 'radium' })
    expect(seen).toEqual([
      [10, 100],
      [100, 100],
    ])
    expect(listeners.has('download-t1')).toBe(false)
  })

  it('passes pull progress through and stops listening even when the pull fails', async () => {
    const seen: string[] = []
    invoke.mockImplementation(async () => {
      listeners.get('ollama-pull-p1')?.({
        payload: { status: 'pulling manifest', completed: null, total: null, done: false },
      })
      throw new Error('pull model manifest: file does not exist')
    })
    await expect(
      ollama.pull('http://127.0.0.1:11434', 'nope', 'p1', (p) => seen.push(p.status))
    ).rejects.toThrow('file does not exist')
    expect(seen).toEqual(['pulling manifest'])
    expect(listeners.has('ollama-pull-p1')).toBe(false)
    expect(invoke).toHaveBeenCalledWith('ollama_pull', {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'nope',
      taskId: 'p1',
    })
  })
})
