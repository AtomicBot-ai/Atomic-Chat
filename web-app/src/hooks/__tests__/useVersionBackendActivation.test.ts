import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'

const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const activateEngineBuildThroughCore = vi.hoisted(() =>
  vi.fn<
    (engine: string, version: string, variant: string) => Promise<unknown>
  >()
)
vi.mock('@/services/engines/update', () => ({ activateEngineBuildThroughCore }))

const updateSettings = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ providers: () => ({ updateSettings }) }),
}))

const { useVersionBackendActivation } = await import(
  '../useVersionBackendActivation'
)

const PREVIOUS = 'b11500/win-cuda-13.3-x64'
const PICK = 'b11400/win-vulkan-x64'

/** The provider page's view of the upstream provider. */
function seed(device = 'CUDA0') {
  useModelProvider.setState({
    providers: [
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [],
        settings: [
          {
            key: 'version_backend',
            title: 'Version',
            description: '',
            controller_type: 'dropdown',
            controller_props: { value: PREVIOUS, options: [] },
          },
          {
            key: 'device',
            title: 'Device',
            description: '',
            controller_type: 'input',
            controller_props: { value: device },
          },
        ],
      },
    ] as never,
  })
}

const shown = () =>
  useModelProvider
    .getState()
    .getProviderByName('llamacpp-upstream')
    ?.settings.find((s) => s.key === 'version_backend')?.controller_props.value

describe('useVersionBackendActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
  })

  it('asks the core to activate the installed build picked in the list, writing no version itself', async () => {
    activateEngineBuildThroughCore.mockResolvedValue({
      activated: true,
      active: { version: 'b11400', variant: 'win-vulkan-x64' },
    })
    const { result } = renderHook(() =>
      useVersionBackendActivation('llamacpp-upstream')
    )

    await act(() => result.current.choose(PICK))

    expect(activateEngineBuildThroughCore).toHaveBeenCalledWith(
      'llamacpp-upstream',
      'b11400',
      'win-vulkan-x64'
    )
    expect(shown()).toBe(PICK)
    // The device belongs to the old build's family: it is cleared, and the
    // version is never part of what the page writes.
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const written = updateSettings.mock.calls[0][1] as { key: string }[]
    expect(written.map((s) => s.key)).toEqual(['device'])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('puts the list back and says why when the core refuses', async () => {
    activateEngineBuildThroughCore.mockRejectedValue({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
      message: 'An update of llamacpp-upstream is running.',
    })
    const { result } = renderHook(() =>
      useVersionBackendActivation('llamacpp-upstream')
    )

    await act(() => result.current.choose(PICK))

    expect(shown()).toBe(PREVIOUS)
    expect(updateSettings).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'settings:backendUpdater.activateFailed',
      { description: 'An update of llamacpp-upstream is running.' }
    )
  })

  it('writes nothing when the device was already unset', async () => {
    seed('')
    activateEngineBuildThroughCore.mockResolvedValue({
      activated: true,
      active: { version: 'b11400', variant: 'win-vulkan-x64' },
    })
    const { result } = renderHook(() =>
      useVersionBackendActivation('llamacpp-upstream')
    )

    await act(() => result.current.choose(PICK))

    expect(updateSettings).not.toHaveBeenCalled()
    expect(shown()).toBe(PICK)
  })

  it('refuses a value that names no build, without asking the core', async () => {
    const { result } = renderHook(() =>
      useVersionBackendActivation('llamacpp-upstream')
    )

    await act(() => result.current.choose('none'))

    expect(activateEngineBuildThroughCore).not.toHaveBeenCalled()
    expect(shown()).toBe(PREVIOUS)
  })
})
