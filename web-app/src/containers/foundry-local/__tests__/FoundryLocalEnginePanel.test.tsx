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

import { FoundryLocalEnginePanel } from '../FoundryLocalEnginePanel'
import { useFoundryLocalInstallStore } from '../install-store'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import type { EngineVersions } from '@/services/engines/types'

function versions(extra: Partial<EngineVersions> = {}): EngineVersions {
  return {
    engine: 'foundry-local',
    kind: 'engine-build',
    active_choice: 'core',
    builds: [],
    active: null,
    latest: { version: 'v2.1.0', variant: 'win-x64', download_bytes: 120 * 1024 ** 2 },
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
    engines: entry ? { 'foundry-local': entry } : {},
    refresh,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FoundryLocalEnginePanel', () => {
  it('offers to install the engine when none is installed, and installs it with progress', async () => {
    hold(versions())
    let finish: (value: unknown) => void = () => {}
    install.installEngineBuildWithProgress.mockImplementation(
      (_engine: string, options: { onProgress?: (p: { transferred: number; total: number }) => void }) => {
        options.onProgress?.({ transferred: 30, total: 120 })
        return new Promise((resolve) => (finish = resolve))
      }
    )

    render(<FoundryLocalEnginePanel />)
    fireEvent.click(screen.getByRole('button', { name: /providers:foundryLocal.engine.install/ }))

    expect(install.installEngineBuildWithProgress).toHaveBeenCalledWith(
      'foundry-local',
      expect.objectContaining({ taskId: 'engine-build-foundry-local-v2_1_0' })
    )
    expect(await screen.findByText('providers:foundryLocal.engine.installing {"percent":25}')).toBeInTheDocument()
    await act(async () => finish({ installed: true }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('says why there is nothing to install when no release fits this computer', () => {
    hold(versions({ latest: null, source_error: 'lists no release this core can install' }))

    render(<FoundryLocalEnginePanel />)

    expect(screen.getByText('lists no release this core can install')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /providers:foundryLocal.engine.install/ })).not.toBeInTheDocument()
  })

  it('shows the installed build, the builds list and the update the core offers', async () => {
    hold(
      versions({
        active: { version: 'v2.1.0', variant: 'win-x64' },
        builds: [
          {
            version: 'v2.1.0',
            variant: 'win-x64',
            origin: 'downloaded',
            active: true,
            in_use: false,
            removable: false,
            not_removable_reason: 'active',
          },
        ],
        update: { needed: true, target: { version: 'v2.2.0', variant: 'win-x64' }, apply: 'swap' },
      })
    )
    update.updateEngineWithProgress.mockResolvedValue({ updated: true, active: null, retired: [], kept_in_use: [] })

    render(<FoundryLocalEnginePanel />)

    expect(screen.getByText('providers:foundryLocal.engine.installed {"version":"v2.1.0"}')).toBeInTheDocument()
    expect(screen.getByTestId('builds-foundry-local')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.engine.update {"version":"v2.2.0"}' }))
    await waitFor(() =>
      expect(update.updateEngineWithProgress).toHaveBeenCalledWith(
        'foundry-local',
        expect.objectContaining({ backend: 'v2.2.0/win-x64' })
      )
    )
  })

  it('tells the person what Microsoft’s library sends, whatever the state', () => {
    hold(versions())

    render(<FoundryLocalEnginePanel />)

    expect(screen.getByText('providers:foundryLocal.telemetry')).toBeInTheDocument()
  })

  it('says it is checking, not that there is no build, before the core has answered', () => {
    hold(undefined)

    render(<FoundryLocalEnginePanel />)

    expect(screen.getByText('providers:foundryLocal.engine.checking')).toBeInTheDocument()
    expect(screen.queryByText('providers:foundryLocal.engine.noBuild')).not.toBeInTheDocument()
  })

  it('marks the build it installed, so the accelerators block prepares them right away', async () => {
    useFoundryLocalInstallStore.setState({ justInstalled: null })
    hold(versions())
    install.installEngineBuildWithProgress.mockResolvedValue({
      installed: true,
      build: { tag: 'v2.1.0', backend_id: 'win-x64', origin: 'downloaded' },
      retired: [],
      kept_in_use: [],
    })

    render(<FoundryLocalEnginePanel />)
    fireEvent.click(screen.getByRole('button', { name: /providers:foundryLocal.engine.install/ }))

    await waitFor(() => expect(useFoundryLocalInstallStore.getState().justInstalled).toBe('v2.1.0/win-x64'))
  })

  it('marks the build an update moved to', async () => {
    useFoundryLocalInstallStore.setState({ justInstalled: null })
    hold(
      versions({
        active: { version: 'v2.1.0', variant: 'win-x64' },
        update: { needed: true, target: { version: 'v2.2.0', variant: 'win-x64' }, apply: 'swap' },
      })
    )
    update.updateEngineWithProgress.mockResolvedValue({
      updated: true,
      active: { version: 'v2.2.0', variant: 'win-x64' },
      retired: [],
      kept_in_use: [],
    })

    render(<FoundryLocalEnginePanel />)
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.engine.update {"version":"v2.2.0"}' }))

    await waitFor(() => expect(useFoundryLocalInstallStore.getState().justInstalled).toBe('v2.2.0/win-x64'))
  })
})
