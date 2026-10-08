import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EngineBuild, EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

const core = vi.hoisted(() => ({
  deleteEngineBuild: vi.fn(),
  engineVersions: vi.fn(),
}))
vi.mock('@/services/engines/core', () => core)
const activateEngineBuildThroughCore = vi.hoisted(() => vi.fn())
vi.mock('@/services/engines/update', () => ({ activateEngineBuildThroughCore }))

const { InstalledEngineBuilds } = await import('../InstalledEngineBuilds')

const makeBuild = (patch: Partial<EngineBuild>): EngineBuild => ({
  version: 'b11400',
  variant: 'win-vulkan-x64',
  origin: 'downloaded',
  active: false,
  in_use: false,
  removable: true,
  ...patch,
})

const ACTIVE = makeBuild({
  version: 'b11500',
  variant: 'win-cuda-13.3-x64',
  active: true,
  removable: false,
  not_removable_reason: 'active',
})
const BUNDLED = makeBuild({
  version: 'b11443',
  variant: 'win-cpu-x64',
  origin: 'bundled',
  removable: false,
  not_removable_reason: 'bundled',
})
const BUSY = makeBuild({
  version: 'b11300',
  variant: 'win-cuda-13.3-x64',
  in_use: true,
  removable: false,
  not_removable_reason: 'in-use',
})
const OLD = makeBuild({})

const hold = (
  entry: Partial<EngineVersions> & Pick<EngineVersions, 'engine'>
) =>
  act(() => {
    useEngineVersionsStore.setState({
      engines: {
        [entry.engine]: {
          kind: 'llamacpp',
          active_choice: 'client',
          builds: [],
          active: null,
          latest: null,
          update: { needed: false, target: null, apply: 'swap' },
          source: 'remote',
          source_error: null,
          error: null,
          ...entry,
        },
      },
    })
  })

const row = (version: string) => screen.getByTestId(`engine-build-${version}`)

describe('InstalledEngineBuilds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEngineVersionsStore.getState().reset()
    // The core answers with what it holds; the list is asked again after each action.
    core.engineVersions.mockImplementation(async () => ({
      engines: Object.values(useEngineVersionsStore.getState().engines),
    }))
    core.deleteEngineBuild.mockResolvedValue({ removed: true })
    activateEngineBuildThroughCore.mockResolvedValue({
      activated: true,
      active: { version: OLD.version, variant: OLD.variant },
    })
    hold({
      engine: 'llamacpp-upstream',
      builds: [ACTIVE, BUNDLED, BUSY, OLD],
      active: { version: ACTIVE.version, variant: ACTIVE.variant },
    })
  })

  it('lists each build with its version, variant, origin and marks', () => {
    render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

    const active = row('b11500')
    expect(within(active).getByText('b11500')).toBeInTheDocument()
    expect(within(active).getByText('win-cuda-13.3-x64')).toBeInTheDocument()
    expect(
      within(active).getByText('settings:engineBuilds.active')
    ).toBeInTheDocument()
    expect(
      within(row('b11443')).getByText('settings:engineBuilds.origin.bundled')
    ).toBeInTheDocument()
    expect(
      within(row('b11300')).getByText('settings:engineBuilds.inUse')
    ).toBeInTheDocument()
    expect(
      within(row('b11400')).getByText('settings:engineBuilds.origin.downloaded')
    ).toBeInTheDocument()
  })

  it.each([
    ['b11500', 'settings:engineBuilds.notRemovable.active'],
    ['b11443', 'settings:engineBuilds.notRemovable.bundled'],
    ['b11300', 'settings:engineBuilds.notRemovable.in-use'],
  ])('disables Remove for %s and says why', (version, reason) => {
    render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

    expect(
      within(row(version)).getByRole('button', {
        name: 'settings:engineBuilds.remove',
      })
    ).toBeDisabled()
    expect(within(row(version)).getByText(reason)).toBeInTheDocument()
  })

  it('removes a build only after the user confirms, through the core', async () => {
    const user = userEvent.setup()
    render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

    await user.click(
      within(row('b11400')).getByRole('button', {
        name: 'settings:engineBuilds.remove',
      })
    )
    expect(core.deleteEngineBuild).not.toHaveBeenCalled()
    expect(
      screen.getByText('settings:engineBuilds.confirmRemoveTitle')
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', {
        name: 'settings:engineBuilds.confirmRemove',
      })
    )

    expect(core.deleteEngineBuild).toHaveBeenCalledWith(
      'llamacpp-upstream',
      'b11400',
      'win-vulkan-x64'
    )
    // The list is asked again rather than edited by hand.
    expect(core.engineVersions).toHaveBeenCalled()
    expect(
      screen.queryByText('settings:engineBuilds.confirmRemoveTitle')
    ).not.toBeInTheDocument()
  })

  it('keeps the build when the user cancels', async () => {
    const user = userEvent.setup()
    render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

    await user.click(
      within(row('b11400')).getByRole('button', {
        name: 'settings:engineBuilds.remove',
      })
    )
    await user.click(
      screen.getByRole('button', { name: 'settings:engineBuilds.cancel' })
    )

    expect(core.deleteEngineBuild).not.toHaveBeenCalled()
    expect(row('b11400')).toBeInTheDocument()
  })

  it.each([
    [
      { code: 'BACKEND_IN_USE', message: 'in use' },
      'settings:engineBuilds.error.inUse',
    ],
    [
      { code: 'INVALID_REQUEST', message: 'bundled', details: 'bundled' },
      'settings:engineBuilds.error.invalid',
    ],
  ])(
    'says why the core refused a removal, without breaking the page',
    async (error, text) => {
      const user = userEvent.setup()
      core.deleteEngineBuild.mockRejectedValue(error)
      render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

      await user.click(
        within(row('b11400')).getByRole('button', {
          name: 'settings:engineBuilds.remove',
        })
      )
      await user.click(
        screen.getByRole('button', {
          name: 'settings:engineBuilds.confirmRemove',
        })
      )

      expect(await screen.findByText(new RegExp(text))).toBeInTheDocument()
      expect(row('b11400')).toBeInTheDocument()
    }
  )

  it('makes an inactive build active through the core, without a confirmation', async () => {
    const user = userEvent.setup()
    render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

    // The active build has nothing to switch to.
    expect(
      within(row('b11500')).queryByRole('button', {
        name: 'settings:engineBuilds.makeActive',
      })
    ).not.toBeInTheDocument()
    await user.click(
      within(row('b11443')).getByRole('button', {
        name: 'settings:engineBuilds.makeActive',
      })
    )

    expect(activateEngineBuildThroughCore).toHaveBeenCalledWith(
      'llamacpp-upstream',
      'b11443',
      'win-cpu-x64'
    )
    expect(core.engineVersions).toHaveBeenCalled()
  })

  it('warns that loaded models unload, only when the provider has some', () => {
    const { rerender } = render(
      <InstalledEngineBuilds engine="llamacpp-upstream" />
    )
    expect(
      screen.queryByText('settings:engineBuilds.unloadWarning')
    ).not.toBeInTheDocument()

    rerender(
      <InstalledEngineBuilds engine="llamacpp-upstream" hasLoadedModels />
    )
    expect(
      screen.getByText('settings:engineBuilds.unloadWarning')
    ).toBeInTheDocument()
  })

  it('says why the core refused an activation', async () => {
    const user = userEvent.setup()
    activateEngineBuildThroughCore.mockRejectedValue({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
      message: 'An update of llamacpp-upstream is running.',
    })
    render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

    await user.click(
      within(row('b11400')).getByRole('button', {
        name: 'settings:engineBuilds.makeActive',
      })
    )

    expect(
      await screen.findByText(/An update of llamacpp-upstream is running\./)
    ).toBeInTheDocument()
  })

  it('says a build to activate is gone, not that it cannot be removed', async () => {
    const user = userEvent.setup()
    activateEngineBuildThroughCore.mockRejectedValue({
      code: 'INVALID_REQUEST',
      message: 'b11400/win-vulkan-x64 is not installed.',
      details: 'not-installed',
    })
    render(<InstalledEngineBuilds engine="llamacpp-upstream" />)

    await user.click(
      within(row('b11400')).getByRole('button', { name: 'settings:engineBuilds.makeActive' })
    )

    expect(
      await screen.findByText(/settings:engineBuilds\.error\.notInstalled/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/settings:engineBuilds\.error\.invalid/)).not.toBeInTheDocument()
  })

  it('offers no "Make active" where the core picks the build', () => {
    hold({
      engine: 'sd-cpp',
      kind: 'engine-build',
      active_choice: 'core',
      builds: [
        makeBuild({
          version: 'master-900',
          variant: 'macos-arm64',
          active: true,
          removable: false,
          not_removable_reason: 'active',
        }),
        makeBuild({ version: 'master-849', variant: 'macos-arm64' }),
      ],
    })
    render(<InstalledEngineBuilds engine="sd-cpp" />)

    expect(
      screen.queryByRole('button', { name: 'settings:engineBuilds.makeActive' })
    ).not.toBeInTheDocument()
    expect(
      within(row('master-849')).getByRole('button', {
        name: 'settings:engineBuilds.remove',
      })
    ).toBeEnabled()
  })

  it('renders nothing for an engine the core did not answer about', () => {
    const { container } = render(<InstalledEngineBuilds engine="mlx" />)
    expect(container).toBeEmptyDOMElement()
  })
})
