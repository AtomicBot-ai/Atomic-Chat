import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BaseExtension } from './extension'
import { SettingComponentProps } from '../types'
vi.mock('./core')
vi.mock('./fs')

class TestBaseExtension extends BaseExtension {
  onLoad(): void {}
  onUnload(): void {}
}

describe('BaseExtension', () => {
  let baseExtension: TestBaseExtension

  beforeEach(() => {
    baseExtension = new TestBaseExtension('https://example.com', 'TestExtension')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should have the correct properties', () => {
    expect(baseExtension.name).toBe('TestExtension')
    expect(baseExtension.productName).toBeUndefined()
    expect(baseExtension.url).toBe('https://example.com')
    expect(baseExtension.active).toBeUndefined()
    expect(baseExtension.description).toBeUndefined()
    expect(baseExtension.version).toBeUndefined()
  })

  it('should return undefined for type()', () => {
    expect(baseExtension.type()).toBeUndefined()
  })

  it('should have abstract methods onLoad() and onUnload()', () => {
    expect(baseExtension.onLoad).toBeDefined()
    expect(baseExtension.onUnload).toBeDefined()
  })

  it('should install the extension', async () => {
    await baseExtension.install()
    // Add your assertions here
  })
})

describe('BaseExtension', () => {
  class TestBaseExtension extends BaseExtension {
    onLoad(): void {}
    onUnload(): void {}
  }

  let baseExtension: TestBaseExtension

  beforeEach(() => {
    baseExtension = new TestBaseExtension('https://example.com', 'TestExtension')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should have the correct properties', () => {
    expect(baseExtension.name).toBe('TestExtension')
    expect(baseExtension.productName).toBeUndefined()
    expect(baseExtension.url).toBe('https://example.com')
    expect(baseExtension.active).toBeUndefined()
    expect(baseExtension.description).toBeUndefined()
    expect(baseExtension.version).toBeUndefined()
  })

  it('should return undefined for type()', () => {
    expect(baseExtension.type()).toBeUndefined()
  })

  it('should have abstract methods onLoad() and onUnload()', () => {
    expect(baseExtension.onLoad).toBeDefined()
    expect(baseExtension.onUnload).toBeDefined()
  })

  it('should install the extension', async () => {
    await baseExtension.install()
    // Add your assertions here
  })

  it('should register settings', async () => {
    const settings: SettingComponentProps[] = [
      { key: 'setting1', controllerProps: { value: 'value1' } } as any,
      { key: 'setting2', controllerProps: { value: 'value2' } } as any,
    ]

    const localStorageMock = (() => {
      let store: Record<string, string> = {}

      return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => {
          store[key] = value
        },
        removeItem: (key: string) => {
          delete store[key]
        },
        clear: () => {
          store = {}
        },
      }
    })()

    Object.defineProperty(global, 'localStorage', {
      value: localStorageMock,
    })
    const mock = vi.spyOn(localStorage, 'setItem')
    await baseExtension.registerSettings(settings)

    expect(mock).toHaveBeenCalledWith(
      'TestExtension',
      JSON.stringify(settings)
    )
  })

  it('should get setting with default value', async () => {
    const settings: SettingComponentProps[] = [
      { key: 'setting1', controllerProps: { value: 'value1' } } as any,
    ]

    vi.spyOn(baseExtension, 'getSettings').mockResolvedValue(settings)

    const value = await baseExtension.getSetting('setting1', 'defaultValue')
    expect(value).toBe('value1')

    const defaultValue = await baseExtension.getSetting('setting2', 'defaultValue')
    expect(defaultValue).toBe('defaultValue')
  })

  it('should update settings', async () => {
    const settings: SettingComponentProps[] = [
      { key: 'setting1', controllerProps: { value: 'value1' } } as any,
    ]

    vi.spyOn(baseExtension, 'getSettings').mockResolvedValue(settings)
    const mockSetItem = vi.spyOn(localStorage, 'setItem')

    await baseExtension.updateSettings([
      { key: 'setting1', controllerProps: { value: 'newValue' } } as any,
    ])

    expect(mockSetItem).toHaveBeenCalledWith(
      'TestExtension',
      JSON.stringify([{ key: 'setting1', controllerProps: { value: 'newValue' } }])
    )
  })

  it('should reset dropdown value when persisted value is no longer valid', async () => {
    localStorage.clear()

    const oldSettings = [
      {
        key: 'flash_attn',
        controllerProps: {
          value: 'ON',
          options: [
            { value: 'auto', name: 'Auto' },
            { value: 'on', name: 'ON' },
            { value: 'off', name: 'OFF' },
          ],
        },
      },
    ]

    localStorage.setItem('TestExtension', JSON.stringify(oldSettings))

    const newSettings: SettingComponentProps[] = [
      {
        key: 'flash_attn',
        controllerProps: {
          value: 'auto',
          options: [
            { value: 'auto', name: 'Auto' },
            { value: 'on', name: 'On' },
            { value: 'off', name: 'Off' },
          ],
        },
      } as any,
    ]

    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    await baseExtension.registerSettings(newSettings)

    expect(setItemSpy).toHaveBeenCalled()
    const [, latestPayload] = setItemSpy.mock.calls[setItemSpy.mock.calls.length - 1]
    const persistedSettings = JSON.parse(latestPayload)
    const flashSetting = persistedSettings.find(
      (setting: any) => setting.key === 'flash_attn'
    )

    expect(flashSetting.controllerProps.value).toBe('auto')

    setItemSpy.mockRestore()
    localStorage.clear()
  })

  it('takes the freshly registered recommendation over the stored one', async () => {
    localStorage.clear()
    localStorage.setItem(
      'TestExtension',
      JSON.stringify([
        {
          key: 'version_backend',
          controllerProps: {
            value: 'b1/macos-arm64',
            options: [{ value: 'b1/macos-arm64', name: 'b1' }],
            recommended: 'b0/macos-arm64',
          },
        },
      ])
    )

    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    await baseExtension.registerSettings([
      {
        key: 'version_backend',
        controllerProps: {
          value: 'b1/macos-arm64',
          options: [
            { value: 'b1/macos-arm64', name: 'b1' },
            { value: 'b2/macos-arm64', name: 'b2' },
          ],
          recommended: 'b2/macos-arm64',
        },
      } as any,
    ])

    const [, latestPayload] = setItemSpy.mock.calls[setItemSpy.mock.calls.length - 1]
    const persisted = JSON.parse(latestPayload).find(
      (setting: any) => setting.key === 'version_backend'
    )

    // A stale recommendation is a dead end: it names a build the dropdown no
    // longer offers, so the UI points at something the user cannot pick.
    expect(persisted.controllerProps.recommended).toBe('b2/macos-arm64')

    setItemSpy.mockRestore()
    localStorage.clear()
  })

  it('keeps the stored recommendation when the registration carries none', async () => {
    localStorage.clear()
    localStorage.setItem(
      'TestExtension',
      JSON.stringify([
        {
          key: 'version_backend',
          controllerProps: {
            value: 'b1/macos-arm64',
            options: [{ value: 'b1/macos-arm64', name: 'b1' }],
            recommended: 'b1/macos-arm64',
          },
        },
      ])
    )

    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    // The settings schema ships an empty recommendation, and every cold start
    // registers it before the catalog resolves.
    await baseExtension.registerSettings([
      {
        key: 'version_backend',
        controllerProps: {
          value: 'b1/macos-arm64',
          options: [{ value: 'b1/macos-arm64', name: 'b1' }],
          recommended: '',
        },
      } as any,
    ])

    const [, latestPayload] = setItemSpy.mock.calls[setItemSpy.mock.calls.length - 1]
    const persisted = JSON.parse(latestPayload).find(
      (setting: any) => setting.key === 'version_backend'
    )

    expect(persisted.controllerProps.recommended).toBe('b1/macos-arm64')

    setItemSpy.mockRestore()
    localStorage.clear()
  })
})
