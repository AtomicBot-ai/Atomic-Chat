import { beforeEach, describe, expect, it } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import {
  checkFoundryLocalVariant,
  foundryLocalAccelerators,
  prepareFoundryLocalAccelerators,
} from '../core'
import type { FoundryLocalAccelerators } from '../types'

type Call = { method: string; path: string; body: unknown }

const probed: FoundryLocalAccelerators = {
  installed: true,
  build: 'v2.1.0/win-x64',
  version: '2.1.0',
  c_api_version: 2,
  probed_at: 1_760_000_000_000,
  accelerators: [
    {
      name: 'OpenVINOExecutionProvider',
      execution_provider: 'openvino',
      device: 'gpu/npu',
      prepared: false,
    },
    {
      name: 'CUDAExecutionProvider',
      execution_provider: 'cuda',
      device: 'gpu',
      prepared: false,
      reason: 'libcublasLt.so.12: cannot open shared object file',
    },
  ],
  error: null,
}

describe('Foundry Local core client', () => {
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

  it('reads the accelerators of the active build, probing again only when forced', async () => {
    answer = () => probed
    await expect(foundryLocalAccelerators()).resolves.toEqual(probed)
    await expect(foundryLocalAccelerators({ force: true })).resolves.toEqual(probed)
    expect(calls).toEqual([
      { method: 'GET', path: '/runtimes/foundry-local/accelerators', body: null },
      { method: 'GET', path: '/runtimes/foundry-local/accelerators?force=1', body: null },
    ])
  })

  it('prepares the named accelerators and returns the summary, failures with their reason', async () => {
    const summary = {
      accelerators: [
        { name: 'WebGpuExecutionProvider', prepared: true },
        { name: 'CUDAExecutionProvider', prepared: false, reason: 'network lost' },
      ],
    }
    answer = () => summary
    await expect(
      prepareFoundryLocalAccelerators(['WebGpuExecutionProvider', 'CUDAExecutionProvider'])
    ).resolves.toEqual(summary)
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/runtimes/foundry-local/accelerators/prepare',
        body: { accelerators: ['WebGpuExecutionProvider', 'CUDAExecutionProvider'] },
      },
    ])
  })

  it('prepares every accelerator the library offers when none is named', async () => {
    answer = () => ({ accelerators: [] })
    await prepareFoundryLocalAccelerators()
    expect(calls[0].body).toEqual({})
  })

  it("asks the core's verdict on a variant by its accelerator and device", async () => {
    const verdict = {
      verdict: 'accelerator-unavailable',
      reason: 'This computer has no NPU.',
      accelerator: 'OpenVINOExecutionProvider',
    }
    answer = () => verdict
    await expect(
      checkFoundryLocalVariant({ execution_provider: 'openvino', device: 'npu' })
    ).resolves.toEqual(verdict)
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/models/foundry-local/check',
        body: { execution_provider: 'openvino', device: 'npu' },
      },
    ])
  })
})
