import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLlamacppDevices } from '../useLlamacppDevices'
import type { HardwareService } from '@/services/hardware/types'
import type { ProvidersService } from '@/services/providers/types'
import { seedServiceHub } from '@/test/service-hub'

// Mock the ServiceHub
const mockGetLlamacppDevices = vi.fn()

// Mock useModelProvider
const mockUpdateProvider = vi.fn()
const mockGetProviderByName = vi.fn((_name: string) => ({
  settings: [
    {
      key: 'device',
      controller_props: { value: '' },
    },
  ],
}))
vi.mock('../useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      getProviderByName: mockGetProviderByName,
      updateProvider: mockUpdateProvider,
    }),
  },
}))

// Mock the window.core object
Object.defineProperty(window, 'core', {
  value: {
    extensionManager: {
      getByName: vi.fn(),
    },
  },
  writable: true,
})

describe('useLlamacppDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedServiceHub({
      hardware: {
        getLlamacppDevices: mockGetLlamacppDevices,
      } as HardwareService,
      providers: {
        updateSettings: vi.fn().mockResolvedValue(undefined),
      } as ProvidersService,
    })
  })

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useLlamacppDevices())

    expect(result.current.devices).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(typeof result.current.fetchDevices).toBe('function')
    expect(typeof result.current.clearError).toBe('function')
    expect(typeof result.current.setDevices).toBe('function')
    expect(typeof result.current.toggleDevice).toBe('function')
  })

  it('should fetch devices successfully with activation status', async () => {
    const mockDevices = [
      { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4090', mem: 24576, free: 20480 },
      { id: 'CUDA1', name: 'NVIDIA GeForce RTX 3080', mem: 10240, free: 8192 },
    ]

    mockGetLlamacppDevices.mockResolvedValue(mockDevices)

    const { result } = renderHook(() => useLlamacppDevices())

    await act(async () => {
      await result.current.fetchDevices()
    })

    // Should have devices with activated property (empty setting means all activated)
    expect(result.current.devices).toEqual([
      { ...mockDevices[0], activated: true },
      { ...mockDevices[1], activated: true },
    ])
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(mockGetLlamacppDevices).toHaveBeenCalledOnce()
  })

  // Regression: the device ids come from LOCAL_LLAMACPP_EXTENSION_NAME
  // (`@janhq/llamacpp-upstream-extension`), so both the read that derives
  // `activated` and the write that persists a toggle must address
  // LOCAL_LLAMACPP_PROVIDER. Addressing the turboquant `llamacpp` provider
  // made the Hardware page's GPU switches a no-op on Windows/Linux, where
  // that extension is not bundled at all.
  it('reads and writes the `device` setting on the provider the devices came from', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      hardware: {
        getLlamacppDevices: mockGetLlamacppDevices,
      } as HardwareService,
      providers: { updateSettings } as unknown as ProvidersService,
    })
    mockGetLlamacppDevices.mockResolvedValue([
      { id: 'Vulkan0', name: 'AMD Radeon RX 7800 XT', mem: 16384, free: 15000 },
    ])

    const { result } = renderHook(() => useLlamacppDevices())

    await act(async () => {
      await result.current.fetchDevices()
    })
    expect(mockGetProviderByName).toHaveBeenCalledWith('llamacpp-upstream')

    await act(async () => {
      await result.current.toggleDevice('Vulkan0')
    })

    expect(mockGetProviderByName).toHaveBeenLastCalledWith('llamacpp-upstream')
    expect(updateSettings).toHaveBeenCalledWith(
      'llamacpp-upstream',
      expect.arrayContaining([
        expect.objectContaining({ key: 'device' }),
      ])
    )
    expect(mockUpdateProvider).toHaveBeenCalledWith(
      'llamacpp-upstream',
      expect.objectContaining({ settings: expect.any(Array) })
    )
  })

  it('should clear error', () => {
    const { result } = renderHook(() => useLlamacppDevices())

    // Set an error first
    act(() => {
      result.current.setDevices([])
    })

    // Clear the error
    act(() => {
      result.current.clearError()
    })

    expect(result.current.error).toBeNull()
  })

  it('should set devices directly', () => {
    const mockDevices = [
      { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4090', mem: 24576, free: 20480 },
    ]

    const { result } = renderHook(() => useLlamacppDevices())

    act(() => {
      result.current.setDevices(mockDevices)
    })

    expect(result.current.devices).toEqual(mockDevices)
  })

  it('should toggle device activation', async () => {
    const { result } = renderHook(() => useLlamacppDevices())

    // Set initial devices with activation status
    act(() => {
      result.current.setDevices([
        {
          id: 'CUDA0',
          name: 'NVIDIA GeForce RTX 4090',
          mem: 24576,
          free: 20480,
          activated: false,
        },
        {
          id: 'CUDA1',
          name: 'NVIDIA GeForce RTX 3080',
          mem: 10240,
          free: 8192,
          activated: false,
        },
      ])
    })

    // Toggle a device on
    await act(async () => {
      await result.current.toggleDevice('CUDA0')
    })

    expect(result.current.devices[0].activated).toBe(true)
    expect(result.current.devices[1].activated).toBe(false)

    // Toggle the same device off
    await act(async () => {
      await result.current.toggleDevice('CUDA0')
    })

    expect(result.current.devices[0].activated).toBe(false)
    expect(result.current.devices[1].activated).toBe(false)

    // Toggle multiple devices
    await act(async () => {
      await result.current.toggleDevice('CUDA0')
    })
    await act(async () => {
      await result.current.toggleDevice('CUDA1')
    })

    expect(result.current.devices[0].activated).toBe(true)
    expect(result.current.devices[1].activated).toBe(true)
  })
})
