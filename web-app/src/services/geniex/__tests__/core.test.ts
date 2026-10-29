import { beforeEach, describe, expect, it } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import { checkGeniexModel, geniexAccelerators, prepareGeniexAccelerators } from '../core'
import type { GeniexAccelerators, GeniexCheckResult } from '../types'

type Call = { method: string; path: string; body: unknown }

// What the core answers on a Snapdragon X Elite with the SDK installed (spec geniex-runtime,
// "Устройства библиотеки отдаются клиенту"): the NPU and the GPU, each prepared, nothing to download.
const xElite: GeniexAccelerators = {
  installed: true,
  build: '0.9.3/win-arm64',
  chip: 'x-elite',
  accelerators: [
    { name: 'npu', device: 'npu', version: '0.9.3', size_bytes: 0, prepared: true },
    { name: 'gpu', device: 'gpu', version: '0.9.3', size_bytes: 0, prepared: true },
  ],
  error: null,
}

describe('GenieX core client', () => {
  let calls: Call[]
  let answer: (call: Call) => unknown

  beforeEach(() => {
    calls = []
    answer = () => null
    mockIPC((command: string, args?: InvokeArgs) => {
      expect(command).toBe('atomic_core_call')
      const call = args as Call
      calls.push(call)
      return answer(call)
    })
  })

  it('reads the devices the library found, with the chip of this computer', async () => {
    answer = () => xElite
    await expect(geniexAccelerators()).resolves.toEqual(xElite)
    expect(calls).toEqual([{ method: 'GET', path: '/runtimes/geniex/accelerators', body: null }])
  })

  it('asks prepare, which the core answers without downloading anything', async () => {
    const summary = { accelerators: [{ name: 'npu', prepared: true, reason: 'Nothing to prepare.' }] }
    answer = () => summary
    await expect(prepareGeniexAccelerators(['npu'])).resolves.toEqual(summary)
    await prepareGeniexAccelerators()
    expect(calls).toEqual([
      { method: 'POST', path: '/runtimes/geniex/accelerators/prepare', body: { accelerators: ['npu'] } },
      { method: 'POST', path: '/runtimes/geniex/accelerators/prepare', body: {} },
    ])
  })

  it("asks the core's verdict on a variant before it downloads, and on a model on disk", async () => {
    const verdict: GeniexCheckResult = {
      verdict: 'platform-unsupported',
      reason: 'This bundle is built for the Snapdragon x2-elite; this computer has the x-elite.',
    }
    answer = () => verdict
    await expect(
      checkGeniexModel({ plugin: 'qairt', device: 'npu', chip: 'x2-elite', min_runtime_version: '0.9.3' })
    ).resolves.toEqual(verdict)
    await checkGeniexModel({
      path: '/data/geniex/models/qwen3-4b/Qwen3-4B-Q4_0.gguf',
      plugin: 'llama_cpp',
      device: 'npu',
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/models/geniex/check',
        body: { plugin: 'qairt', device: 'npu', chip: 'x2-elite', min_runtime_version: '0.9.3' },
      },
      {
        method: 'POST',
        path: '/models/geniex/check',
        body: { path: '/data/geniex/models/qwen3-4b/Qwen3-4B-Q4_0.gguf', plugin: 'llama_cpp', device: 'npu' },
      },
    ])
  })
})
