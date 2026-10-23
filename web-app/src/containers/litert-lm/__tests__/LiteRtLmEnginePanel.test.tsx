import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const install = vi.hoisted(() => ({ installEngineBuildWithProgress: vi.fn() }))
vi.mock('@/services/engine-builds/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engine-builds/install')>()),
  ...install,
}))
const update = vi.hoisted(() => ({ updateEngineWithProgress: vi.fn() }))
vi.mock('@/services/engines/update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engines/update')>()),
  ...update,
}))
// The builds list has its own tests; here it only has to be there.
vi.mock('@/containers/engines/InstalledEngineBuilds', () => ({
  InstalledEngineBuilds: ({ engine }: { engine: string }) => <div data-testid={`builds-${engine}`} />,
}))

import { LiteRtLmEnginePanel } from '../LiteRtLmEnginePanel'
import { useLiteRtLmInstallStore } from '../install-store'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import type { EngineVersions } from '@/services/engines/types'

function versions(extra: Partial<EngineVersions> = {}): EngineVersions {
  return {
    engine: 'litert-lm',
    kind: 'engine-build',
    active_choice: 'core',
    builds: [],
    active: null,
    latest: { version: '0.18.1', variant: 'win-x64', download_bytes: 22 * 1024 ** 2 },
    update: { needed: false, target: null, apply: 'swap' },
    source: 'remote',
    source_error: null,
    error: null,
    ...extra,
  }
}

const refresh = vi.fn(async () => {})

function hold(entry: EngineVersions | undefined) {
  useEngineVersionsStore.setState({
    engines: entry ? { 'litert-lm': entry } : {},
    refresh,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useLiteRtLmInstallStore.setState({ justInstalled: null })
})

describe('LiteRtLmEnginePanel', () => {
  it('offers to install the engine when none is installed, installs it with progress and marks the build', async () => {
    hold(versions())
    let finish: (value: unknown) => void = () => {}
    install.installEngineBuildWithProgress.mockImplementation(
      (_engine: string, options: { onProgress?: (p: { transferred: number; total: number }) => void }) => {
        options.onProgress?.({ transferred: 11, total: 22 })
        return new Promise((resolve) => (finish = resolve))
      }
    )

    render(<LiteRtLmEnginePanel />)
    fireEvent.click(screen.getByRole('button', { name: /providers:liteRtLm.engine.install/ }))

    expect(install.installEngineBuildWithProgress).toHaveBeenCalledWith(
      'litert-lm',
      expect.objectContaining({ taskId: 'engine-build-litert-lm-0_18_1' })
    )
    expect(await screen.findByText('providers:liteRtLm.engine.installing {"percent":50}')).toBeInTheDocument()
    await act(async () =>
      finish({
        installed: true,
        build: { tag: '0.18.1', backend_id: 'win-x64', origin: 'downloaded' },
        retired: [],
        kept_in_use: [],
      })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    // The NPU block prepares OpenVINO once it sees this build.
    expect(useLiteRtLmInstallStore.getState().justInstalled).toBe('0.18.1/win-x64')
  })

  it('says why there is nothing to install when no release fits this computer', () => {
    hold(versions({ latest: null, source_error: 'lists no release this core can install' }))

    render(<LiteRtLmEnginePanel />)

    expect(screen.getByText('lists no release this core can install')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /providers:liteRtLm.engine.install/ })).not.toBeInTheDocument()
  })

  it('shows the installed build, the builds list and the update the core offers, and marks the build it moved to', async () => {
    hold(
      versions({
        active: { version: '0.18.1', variant: 'win-x64' },
        update: { needed: true, target: { version: '0.19.0', variant: 'win-x64' }, apply: 'swap' },
      })
    )
    update.updateEngineWithProgress.mockResolvedValue({
      updated: true,
      active: { version: '0.19.0', variant: 'win-x64' },
      retired: [],
      kept_in_use: [],
    })

    render(<LiteRtLmEnginePanel />)

    expect(screen.getByText('providers:liteRtLm.engine.installed {"version":"0.18.1"}')).toBeInTheDocument()
    expect(screen.getByTestId('builds-litert-lm')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:liteRtLm.engine.update {"version":"0.19.0"}' }))
    await waitFor(() =>
      expect(update.updateEngineWithProgress).toHaveBeenCalledWith(
        'litert-lm',
        expect.objectContaining({ backend: '0.19.0/win-x64' })
      )
    )
    await waitFor(() => expect(useLiteRtLmInstallStore.getState().justInstalled).toBe('0.19.0/win-x64'))
  })

  it('says it is checking, not that there is no build, before the core has answered', () => {
    hold(undefined)

    render(<LiteRtLmEnginePanel />)

    expect(screen.getByText('providers:liteRtLm.engine.checking')).toBeInTheDocument()
    expect(screen.queryByText('providers:liteRtLm.engine.noBuild')).not.toBeInTheDocument()
  })

  it('shows the install’s refusal with its reason', async () => {
    hold(versions())
    install.installEngineBuildWithProgress.mockRejectedValue({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'litert-host probe failed: dlopen: image not found',
    })

    render(<LiteRtLmEnginePanel />)
    fireEvent.click(screen.getByRole('button', { name: /providers:liteRtLm.engine.install/ }))

    expect(await screen.findByText('litert-host probe failed: dlopen: image not found')).toBeInTheDocument()
    expect(useLiteRtLmInstallStore.getState().justInstalled).toBeNull()
  })
})
