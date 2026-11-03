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

import { GeniexEnginePanel } from '../GeniexEnginePanel'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import type { EngineVersions } from '@/services/engines/types'

function versions(extra: Partial<EngineVersions> = {}): EngineVersions {
  return {
    engine: 'geniex',
    kind: 'engine-build',
    active_choice: 'core',
    builds: [],
    active: null,
    latest: { version: '0.9.3', variant: 'win-arm64', download_bytes: 91_519_631 },
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
    engines: entry ? { geniex: entry } : {},
    refresh,
  })
}

beforeEach(() => vi.clearAllMocks())

describe('GeniexEnginePanel', () => {
  it('offers to install the SDK when none is installed, and installs it with progress', async () => {
    // spec geniex-desktop "Первый запуск".
    hold(versions())
    let finish: (value: unknown) => void = () => {}
    install.installEngineBuildWithProgress.mockImplementation(
      (_engine: string, options: { onProgress?: (p: { transferred: number; total: number }) => void }) => {
        options.onProgress?.({ transferred: 25, total: 100 })
        return new Promise((resolve) => (finish = resolve))
      }
    )

    render(<GeniexEnginePanel />)
    fireEvent.click(screen.getByRole('button', { name: /providers:geniex.engine.install/ }))

    expect(install.installEngineBuildWithProgress).toHaveBeenCalledWith(
      'geniex',
      expect.objectContaining({ taskId: 'engine-build-geniex-0_9_3' })
    )
    expect(await screen.findByText('providers:geniex.engine.installing {"percent":25}')).toBeInTheDocument()
    await act(async () =>
      finish({
        installed: true,
        build: { tag: '0.9.3', backend_id: 'win-arm64', origin: 'downloaded' },
        retired: [],
        kept_in_use: [],
      })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('says why there is nothing to install when no release fits this computer', () => {
    hold(versions({ latest: null, source_error: 'lists no release this core can install' }))

    render(<GeniexEnginePanel />)

    expect(screen.getByText('lists no release this core can install')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /providers:geniex.engine.install/ })).not.toBeInTheDocument()
  })

  it('shows the installed build, the builds list and the update the core offers', async () => {
    hold(
      versions({
        active: { version: '0.9.3', variant: 'win-arm64' },
        update: { needed: true, target: { version: '0.10.0', variant: 'win-arm64' }, apply: 'swap' },
      })
    )
    update.updateEngineWithProgress.mockResolvedValue({
      updated: true,
      active: { version: '0.10.0', variant: 'win-arm64' },
      retired: [],
      kept_in_use: [],
    })

    render(<GeniexEnginePanel />)

    expect(screen.getByText('providers:geniex.engine.installed {"version":"0.9.3"}')).toBeInTheDocument()
    expect(screen.getByTestId('builds-geniex')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:geniex.engine.update {"version":"0.10.0"}' }))
    await waitFor(() =>
      expect(update.updateEngineWithProgress).toHaveBeenCalledWith(
        'geniex',
        expect.objectContaining({ backend: '0.10.0/win-arm64' })
      )
    )
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('says it is checking, not that there is no build, before the core has answered', () => {
    hold(undefined)

    render(<GeniexEnginePanel />)

    expect(screen.getByText('providers:geniex.engine.checking')).toBeInTheDocument()
    expect(screen.queryByText('providers:geniex.engine.noBuild')).not.toBeInTheDocument()
  })

  it('shows the install’s refusal with its reason', async () => {
    // spec geniex-runtime "Библиотека не загружается": the probe's output comes back as the reason.
    hold(versions())
    install.installEngineBuildWithProgress.mockRejectedValue({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'geniex-host probe failed: geniex.dll not found',
    })

    render(<GeniexEnginePanel />)
    fireEvent.click(screen.getByRole('button', { name: /providers:geniex.engine.install/ }))

    expect(await screen.findByText('geniex-host probe failed: geniex.dll not found')).toBeInTheDocument()
  })
})
