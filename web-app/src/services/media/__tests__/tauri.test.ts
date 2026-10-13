import { afterEach, describe, expect, it } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import { DefaultMediaService } from '../default'
import { isAbsentMedia, TauriMediaService } from '../tauri'

type Call = { method: string; path: string; body: unknown }

const catalog = { catalog_version: 3, origin: 'live', dialects: {}, providers: {} }

describe('TauriMediaService', () => {
  afterEach(() => clearMocks())

  it('reads the catalog and a provider listing through the core relay', async () => {
    const calls: Call[] = []
    mockIPC((command: string, args?: InvokeArgs) => {
      expect(command).toBe('atomic_core_call')
      const call = args as Call
      calls.push(call)
      if (call.path === '/media/catalog') return catalog
      return { provider: 'my box', kind: 'video', api: null, models: [], live: false }
    })
    const service = new TauriMediaService()
    expect(service.isSupported()).toBe(true)
    await expect(service.catalog()).resolves.toEqual(catalog)
    await service.providerModels('my box', 'video')
    expect(calls).toEqual([
      { method: 'GET', path: '/media/catalog', body: null },
      { method: 'GET', path: '/media/providers/my%20box/models?kind=video', body: null },
    ])
  })

  it.each(['HTTP_404', 'NOT_FOUND', 'ROUTE_NOT_FOUND', 'REMOTE_NOT_CONFIGURED'])(
    'reads %s as a core without remote media',
    async (code) => {
      mockIPC(() => {
        throw { code, message: 'no' }
      })
      await expect(new TauriMediaService().catalog()).resolves.toBeNull()
    }
  )

  it('passes any other failure on', async () => {
    mockIPC(() => {
      throw { code: 'CORE_UNAVAILABLE', message: 'starting' }
    })
    await expect(new TauriMediaService().catalog()).rejects.toMatchObject({
      code: 'CORE_UNAVAILABLE',
    })
  })

  it('recognises only coded rejections', () => {
    expect(isAbsentMedia(new Error('HTTP_404'))).toBe(false)
    expect(isAbsentMedia(null)).toBe(false)
    expect(isAbsentMedia({ code: 'HTTP_404' })).toBe(true)
  })
})

describe('DefaultMediaService', () => {
  it('offers no remote media off desktop', async () => {
    const service = new DefaultMediaService()
    expect(service.isSupported()).toBe(false)
    await expect(service.catalog()).resolves.toBeNull()
  })
})
