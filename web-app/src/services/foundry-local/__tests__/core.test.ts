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

  const minimumRequest = { execution_provider: 'cpu', device: 'cpu', min_runtime_version: '2.4.0' }
  const unknownMinimum = {
    code: 'INVALID_ARGUMENT',
    message: 'The request has fields this core does not know: min_runtime_version.',
  }
  const ok = { verdict: 'ok', reason: null, accelerator: null }

  it.each([
    ['v2.1.0', 'engine-update-required'],
    ['v2.4.0', 'ok'],
    ['v2.10.0', 'ok'],
  ])('checks the active runtime %s when an old core rejects the new field', async (version, verdict) => {
    answer = ({ path, body }) => {
      if (path === '/engines/versions') {
        return { engines: [{ engine: 'foundry-local', active: { version, variant: 'macos-arm64' } }] }
      }
      if (body === minimumRequest) throw unknownMinimum
      return ok
    }

    await expect(checkFoundryLocalVariant(minimumRequest)).resolves.toMatchObject({ verdict })
    expect(calls).toMatchObject([
      { path: '/models/foundry-local/check', body: minimumRequest },
      { path: '/models/foundry-local/check', body: { execution_provider: 'cpu', device: 'cpu' } },
      { path: '/engines/versions' },
    ])
    expect(calls[1].body).not.toHaveProperty('min_runtime_version')
  })

  it('requires a newer core when the old core cannot report the active runtime version', async () => {
    answer = ({ path, body }) => {
      if (path === '/engines/versions') return { engines: [] }
      if (body === minimumRequest) throw unknownMinimum
      return ok
    }
    await expect(checkFoundryLocalVariant(minimumRequest)).rejects.toThrow(/newer Atomic Chat core.*2\.4\.0/i)
  })

  it('does not downgrade the request on other validation errors', async () => {
    const error = { code: 'INVALID_ARGUMENT', message: 'min_runtime_version must be a version in X.Y.Z format.' }
    answer = () => { throw error }
    await expect(checkFoundryLocalVariant(minimumRequest)).rejects.toEqual(error)
    expect(calls).toHaveLength(1)
  })
})
