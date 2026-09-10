import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvokeArgs } from '@tauri-apps/api/core'
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks'
import type { ExtensionManifest } from '@/lib/extension'
import { TauriCoreService } from '../core/tauri'

describe('TauriCoreService', () => {
  let coreService: TauriCoreService
  let ipcHandler: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ipcHandler = vi.fn()
    mockIPC((command: string, args?: InvokeArgs) => ipcHandler(command, args))
    coreService = new TauriCoreService()
  })

  it('passes commands and arguments through real invoke', async () => {
    ipcHandler.mockReturnValue({ ok: true })

    await expect(
      coreService.invoke('custom_command', { value: 42 })
    ).resolves.toEqual({ ok: true })
    expect(ipcHandler).toHaveBeenCalledWith('custom_command', { value: 42 })
  })

  it('uses exact extension command payloads', async () => {
    const extension = {
      name: '@atomic/example-extension',
    } as ExtensionManifest
    ipcHandler.mockImplementation((command: string) => {
      if (command === 'get_active_extensions') return [extension]
      if (command === 'install_extension') return [extension]
      if (command === 'uninstall_extension') return true
      return undefined
    })

    await expect(coreService.getActiveExtensions()).resolves.toEqual([
      extension,
    ])
    await coreService.installExtensions()
    await expect(coreService.installExtension([extension])).resolves.toEqual([
      extension,
    ])
    await expect(
      coreService.uninstallExtension(['@atomic/example-extension'], false)
    ).resolves.toBe(true)

    expect(ipcHandler.mock.calls).toEqual([
      ['get_active_extensions', {}],
      ['install_extensions', {}],
      ['install_extension', { extensions: [extension] }],
      [
        'uninstall_extension',
        {
          extensions: ['@atomic/example-extension'],
          reload: false,
        },
      ],
    ])
  })

  it('uses Tauri convertFileSrc and preserves its fallback contract', () => {
    mockConvertFileSrc('macos')

    expect(coreService.convertFileSrc('/tmp/model file.gguf')).toBe(
      'asset://localhost/%2Ftmp%2Fmodel%20file.gguf'
    )
  })

  it('returns documented fallbacks when extension invokes fail', async () => {
    ipcHandler.mockRejectedValue(new Error('backend unavailable'))

    await expect(coreService.getActiveExtensions()).resolves.toEqual([])
    await expect(coreService.installExtension([])).resolves.toEqual([])
    await expect(coreService.uninstallExtension([])).resolves.toBe(false)
    await expect(coreService.getAppToken()).resolves.toBeNull()
  })
})
