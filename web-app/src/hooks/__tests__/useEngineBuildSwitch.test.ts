import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import type { EngineVersions } from '@/services/engines/types'

const updateSettings = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ providers: () => ({ updateSettings }) }),
}))

const { installableOptions, useClearDeviceAfterSwitch } = await import(
  '../useEngineBuildSwitch'
)

const entry = (patch: Partial<EngineVersions>): EngineVersions => ({
  engine: 'llamacpp-upstream',
  kind: 'llamacpp',
  active_choice: 'client',
  builds: [],
  active: null,
  latest: null,
  update: { needed: false, target: null, apply: 'swap' },
  source: 'remote',
  source_error: null,
  error: null,
  ...patch,
})

const build = (version: string, variant: string) => ({
  version,
  variant,
  origin: 'downloaded' as const,
  active: false,
  in_use: false,
  removable: true,
})

const option = (value: string) => ({ value, name: value })

describe('installableOptions', () => {
  const OPTIONS = [
    option('b11500/win-cuda-13.3-x64'),
    option('﻿b11400/win-vulkan-x64'),
    option('b11300/win-cpu-x64'),
    option('latest/win-cuda-13.3-x64'),
    option('latest/win-vulkan-x64'),
    option('none'),
  ]

  it('offers only what is not installed, and no latest that names the active build', () => {
    const offered = installableOptions(
      entry({
        builds: [
          build('b11500', 'win-cuda-13.3-x64'),
          build('b11400', 'win-vulkan-x64'),
        ],
        active: { version: 'b11500', variant: 'win-cuda-13.3-x64' },
        latest: { version: 'b11500', variant: 'win-cuda-13.3-x64' },
      }),
      OPTIONS
    )
    expect(offered.map((o) => o.value)).toEqual([
      'b11300/win-cpu-x64',
      'latest/win-vulkan-x64',
    ])
  })

  it('keeps the latest of the active variant while a newer one is offered', () => {
    const offered = installableOptions(
      entry({
        builds: [build('b11400', 'win-cuda-13.3-x64')],
        active: { version: 'b11400', variant: 'win-cuda-13.3-x64' },
        latest: { version: 'b11500', variant: 'win-cuda-13.3-x64' },
      }),
      OPTIONS
    )
    expect(offered.map((o) => o.value)).toContain('latest/win-cuda-13.3-x64')
  })

  it('offers every build before the core answered, never a value that names none', () => {
    expect(installableOptions(undefined, OPTIONS).map((o) => o.value)).toEqual(
      OPTIONS.slice(0, 5).map((o) => o.value)
    )
  })
})

function seed(device: string) {
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
            controller_props: {
              value: 'b11500/win-cuda-13.3-x64',
              options: [],
            },
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

const deviceShown = () =>
  useModelProvider
    .getState()
    .getProviderByName('llamacpp-upstream')
    ?.settings.find((s) => s.key === 'device')?.controller_props.value

describe('useClearDeviceAfterSwitch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('clears a device chosen for the old build and writes only the device', () => {
    seed('CUDA0')
    const { result } = renderHook(() =>
      useClearDeviceAfterSwitch('llamacpp-upstream')
    )
    act(() => result.current())
    expect(deviceShown()).toBe('')
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const written = updateSettings.mock.calls[0][1] as { key: string }[]
    expect(written.map((s) => s.key)).toEqual(['device'])
  })

  it('writes nothing when no device was chosen', () => {
    seed('')
    const { result } = renderHook(() =>
      useClearDeviceAfterSwitch('llamacpp-upstream')
    )
    act(() => result.current())
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
