import { beforeEach, describe, expect, it } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import {
  checkLiteRtLmModel,
  liteRtLmAccelerators,
  prepareLiteRtLmAccelerators,
} from '../core'
import type { LiteRtLmAccelerators, LiteRtLmCheckResult } from '../types'

type Call = { method: string; path: string; body: unknown }

const lunarLake: LiteRtLmAccelerators = {
  installed: true,
  build: '0.18.1/win-x64',
  npu: 'intel-lnl',
  accelerators: [
    {
      name: 'openvino',
      device: 'npu',
      version: '2026.4.1',
      size_bytes: 85_000_000,
      prepared: false,
    },
  ],
  error: null,
}

describe('LiteRT-LM core client', () => {
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

  it('reads what the core offers this machine, with what is prepared', async () => {
    answer = () => lunarLake
    await expect(liteRtLmAccelerators()).resolves.toEqual(lunarLake)
    expect(calls).toEqual([
      { method: 'GET', path: '/runtimes/litert-lm/accelerators', body: null },
    ])
  })

  it('prepares the named accelerators, or every one offered when none is named', async () => {
    const summary = { accelerators: [{ name: 'openvino', prepared: true }] }
    answer = () => summary
    await expect(prepareLiteRtLmAccelerators(['openvino'])).resolves.toEqual(summary)
    await prepareLiteRtLmAccelerators()
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/runtimes/litert-lm/accelerators/prepare',
        body: { accelerators: ['openvino'] },
      },
      { method: 'POST', path: '/runtimes/litert-lm/accelerators/prepare', body: {} },
    ])
  })

  it("asks the core's verdict on a variant before it downloads, and on a file on disk", async () => {
    const verdict: LiteRtLmCheckResult = {
      verdict: 'accelerator-unavailable',
      reason: 'This NPU is a Lunar Lake; the variant is built for Panther Lake.',
    }
    answer = () => verdict
    await expect(
      checkLiteRtLmModel({ backend: 'npu', npu: 'intel-ptl' })
    ).resolves.toEqual(verdict)
    await checkLiteRtLmModel({
      path: '/data/litert-lm/models/gemma-4-e2b-it-gpu/gemma-4-E2B-it.litertlm',
      backend: 'gpu',
    })
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/models/litert-lm/check',
        body: { backend: 'npu', npu: 'intel-ptl' },
      },
      {
        method: 'POST',
        path: '/models/litert-lm/check',
        body: {
          path: '/data/litert-lm/models/gemma-4-e2b-it-gpu/gemma-4-E2B-it.litertlm',
          backend: 'gpu',
        },
      },
    ])
  })
})
