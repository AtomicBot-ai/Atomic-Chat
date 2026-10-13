import { beforeEach, describe, expect, it } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import {
  activateEngineBuild,
  deleteEngineBuild,
  engineVersions,
  updateEngine,
} from '../core'
import type { EngineVersionsResponse } from '../types'

type Call = { method: string; path: string; body: unknown }

const versions: EngineVersionsResponse = {
  engines: [
    {
      engine: 'llamacpp-upstream',
      kind: 'llamacpp',
      active_choice: 'client',
      builds: [
        {
          version: 'b11400',
          variant: 'macos-arm64',
          origin: 'bundled',
          active: true,
          in_use: false,
          removable: false,
          not_removable_reason: 'active',
        },
      ],
      active: { version: 'b11400', variant: 'macos-arm64' },
      latest: { version: 'b11500', variant: 'macos-arm64' },
      update: {
        needed: true,
        target: { version: 'b11500', variant: 'macos-arm64' },
        apply: 'swap',
      },
      source: 'remote',
      source_error: null,
      error: null,
    },
  ],
}

describe('engines service', () => {
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

  it('asks the core for every engine’s versions with the request as the body', async () => {
    answer = () => versions
    await expect(
      engineVersions({ force: true, app_version: '2.2.0' })
    ).resolves.toEqual(versions)
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/engines/versions',
        body: { force: true, app_version: '2.2.0' },
      },
    ])
  })

  it('sends an empty request when the caller passes none', async () => {
    answer = () => versions
    await engineVersions()
    expect(calls[0].body).toEqual({})
  })

  it('posts an update to the engine’s own route and returns the core’s answer', async () => {
    const result = {
      updated: true,
      active: { version: 'b11500', variant: 'macos-arm64' },
      retired: [{ version: 'b11300', variant: 'macos-arm64' }],
      kept_in_use: [],
    }
    answer = () => result
    await expect(
      updateEngine('llamacpp-upstream', {
        task_id: 'engine-update-llamacpp-upstream-b11500',
        target: { variant: 'macos-arm64' },
      })
    ).resolves.toEqual(result)
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/engines/llamacpp-upstream/update',
        body: {
          task_id: 'engine-update-llamacpp-upstream-b11500',
          target: { variant: 'macos-arm64' },
        },
      },
    ])
  })

  it('activates a build with no body, each segment encoded', async () => {
    answer = () => ({
      activated: true,
      active: { version: 'b9100-1.7.0', variant: 'win-cuda-12-x64' },
    })
    await activateEngineBuild('llamacpp', 'b9100-1.7.0', 'win-cuda-12-x64')
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/engines/llamacpp/builds/b9100-1.7.0/win-cuda-12-x64/activate',
        body: null,
      },
    ])
  })

  it('deletes a build, encoding a managed variant’s slash and passing retain_models only when given', async () => {
    answer = (call) =>
      call.path.startsWith('/engines/vllm')
        ? { operation_id: 'op-2' }
        : { removed: true }
    await expect(
      deleteEngineBuild('llamacpp', 'b9000-1.6.0', 'win-cuda-12-x64')
    ).resolves.toEqual({ removed: true })
    await expect(
      deleteEngineBuild('vllm', 'vllm-0.31.0-r1', 'linux/amd64', {
        retain_models: false,
      })
    ).resolves.toEqual({ operation_id: 'op-2' })
    expect(calls).toEqual([
      {
        method: 'DELETE',
        path: '/engines/llamacpp/builds/b9000-1.6.0/win-cuda-12-x64',
        body: null,
      },
      {
        method: 'DELETE',
        path: '/engines/vllm/builds/vllm-0.31.0-r1/linux%2Famd64?retain_models=false',
        body: null,
      },
    ])
  })

  it('rejects with the relay’s error as it came', async () => {
    answer = () => {
      throw { code: 'BACKEND_IN_USE', message: 'in use', details: 'b9000' }
    }
    await expect(
      deleteEngineBuild('llamacpp', 'b9000-1.6.0', 'win-cuda-12-x64')
    ).rejects.toEqual({
      code: 'BACKEND_IN_USE',
      message: 'in use',
      details: 'b9000',
    })
  })
})
