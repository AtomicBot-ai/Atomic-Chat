import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeServiceHub, type ServiceHub } from '../index'
import {
  isPlatformAndroid,
  isPlatformIOS,
  isPlatformTauri,
} from '@/lib/platform/utils'

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: vi.fn().mockReturnValue(false),
  isPlatformIOS: vi.fn().mockReturnValue(false),
  isPlatformAndroid: vi.fn().mockReturnValue(false),
  isIOS: vi.fn().mockReturnValue(false),
  isAndroid: vi.fn().mockReturnValue(false),
}))

vi.mock('@jan/extensions-web', () => ({
  WEB_EXTENSIONS: {},
}))

vi.mock('token.js', () => ({
  models: {},
}))

describe('ServiceHub integration', () => {
  beforeEach(() => {
    vi.mocked(isPlatformTauri).mockReturnValue(false)
    vi.mocked(isPlatformIOS).mockReturnValue(false)
    vi.mocked(isPlatformAndroid).mockReturnValue(false)
  })

  it('initializes the web service branch', async () => {
    const serviceHub = await initializeServiceHub()

    expect(serviceHub.core().constructor.name).toBe('DefaultCoreService')
    expect(serviceHub.theme().constructor.name).toBe('DefaultThemeService')
  })

  it('initializes real desktop Tauri adapters', async () => {
    vi.mocked(isPlatformTauri).mockReturnValue(true)

    const serviceHub = await initializeServiceHub()
    const expectedConstructors: Partial<Record<keyof ServiceHub, string>> = {
      theme: 'TauriThemeService',
      window: 'TauriWindowService',
      events: 'TauriEventsService',
      hardware: 'TauriHardwareService',
      app: 'TauriAppService',
      mcp: 'TauriMCPService',
      providers: 'TauriProvidersService',
      dialog: 'TauriDialogService',
      opener: 'TauriOpenerService',
      updater: 'TauriUpdaterService',
      path: 'TauriPathService',
      core: 'TauriCoreService',
      deeplink: 'TauriDeepLinkService',
    }

    for (const [name, constructorName] of Object.entries(
      expectedConstructors
    )) {
      const service = serviceHub[name as keyof ServiceHub]()
      expect(service.constructor.name).toBe(constructorName)
    }
  })

  it('keeps service instances stable after initialization', async () => {
    const serviceHub = await initializeServiceHub()

    expect(serviceHub.theme()).toBe(serviceHub.theme())
    expect(serviceHub.core()).toBe(serviceHub.core())
  })

  it('provides every registered service', async () => {
    const serviceHub = await initializeServiceHub()
    const names: (keyof ServiceHub)[] = [
      'theme',
      'window',
      'events',
      'hardware',
      'app',
      'analytic',
      'messages',
      'mcp',
      'threads',
      'providers',
      'models',
      'assistants',
      'dialog',
      'opener',
      'updater',
      'path',
      'core',
      'deeplink',
      'projects',
      'rag',
      'uploads',
    ]

    for (const name of names) {
      expect(serviceHub[name]()).toBeDefined()
    }
  })
})
