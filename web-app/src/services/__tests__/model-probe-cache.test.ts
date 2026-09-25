import { beforeEach, describe, expect, it, vi } from 'vitest'
import { probeModel, resetModelProbeCache } from '../providers/tauri'

const want = { tools: true, reasoning: true }

describe('probeModel', () => {
  beforeEach(() => {
    resetModelProbeCache()
    vi.restoreAllMocks()
  })

  it('reads a model file once for repeated polls, and again when the file is another size', async () => {
    const engine = {
      isToolSupported: vi.fn().mockResolvedValue(true),
      getReasoningControls: vi.fn().mockResolvedValue({ supportsThinking: true }),
    }

    const first = await probeModel('llamacpp', engine, { id: 'm', sizeBytes: 1 }, want)
    const second = await probeModel('llamacpp', engine, { id: 'm', sizeBytes: 1 }, want)
    expect(second).toEqual(first)
    expect(first).toEqual({ tools: true, reasoning: { supportsThinking: true } })
    expect(engine.isToolSupported).toHaveBeenCalledTimes(1)
    expect(engine.getReasoningControls).toHaveBeenCalledTimes(1)

    await probeModel('llamacpp', engine, { id: 'm', sizeBytes: 2 }, want)
    expect(engine.isToolSupported).toHaveBeenCalledTimes(2)
  })

  it('reports a file it cannot parse once, not on every poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = {
      isToolSupported: vi.fn().mockRejectedValue(new Error('Not a GGUF file')),
      getReasoningControls: vi.fn().mockResolvedValue({ supportsThinking: false }),
    }

    for (let poll = 0; poll < 5; poll++) {
      expect((await probeModel('llamacpp', engine, { id: 'bad' }, want)).tools).toBe(false)
    }
    expect(engine.isToolSupported).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
