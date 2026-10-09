import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { InstallOtherBuild } = await import('../InstallOtherBuild')

const OPTIONS = [
  {
    value: 'b11500/macos-arm64',
    name: 'Apple Silicon · b11500 — installed locally',
  },
  { value: 'b11300/macos-arm64', name: 'Apple Silicon · b11300' },
  { value: 'latest/macos-arm64', name: 'Latest Apple Silicon' },
]

function hold(builds: string[], active: string) {
  const [version, variant] = active.split('/')
  act(() => {
    useEngineVersionsStore.setState({
      engines: {
        'llamacpp-upstream': {
          engine: 'llamacpp-upstream',
          kind: 'llamacpp',
          active_choice: 'client',
          builds: builds.map((key) => {
            const [v, b] = key.split('/')
            return {
              version: v,
              variant: b,
              origin: 'downloaded',
              active: key === active,
              in_use: false,
              removable: key !== active,
            }
          }),
          active: { version, variant },
          latest: { version, variant },
          update: { needed: false, target: null, apply: 'swap' },
          source: 'remote',
          source_error: null,
          error: null,
        } satisfies EngineVersions,
      },
    })
  })
}

describe('InstallOtherBuild', () => {
  beforeEach(() => useEngineVersionsStore.setState({ engines: {} }))

  it('names no current build and offers only what is not on disk', async () => {
    hold(['b11500/macos-arm64'], 'b11500/macos-arm64')
    const onPick = vi.fn()
    render(
      <InstallOtherBuild
        engine="llamacpp-upstream"
        options={OPTIONS}
        onPick={onPick}
      />
    )
    const trigger = screen.getByTestId('engine-install-other-llamacpp-upstream')
    expect(trigger).toHaveTextContent('settings:engineBuilds.installOther')
    await userEvent.click(trigger)
    expect(screen.queryByText(/installed locally/)).toBeNull()
    expect(screen.queryByText('Latest Apple Silicon')).toBeNull()
    await userEvent.click(screen.getByText('Apple Silicon · b11300'))
    expect(onPick).toHaveBeenCalledWith('b11300/macos-arm64')
  })

  it('renders nothing when everything offered is installed', () => {
    hold(['b11500/macos-arm64', 'b11300/macos-arm64'], 'b11500/macos-arm64')
    render(
      <InstallOtherBuild
        engine="llamacpp-upstream"
        options={OPTIONS}
        onPick={vi.fn()}
      />
    )
    expect(
      screen.queryByTestId('engine-install-other-llamacpp-upstream')
    ).toBeNull()
  })
})
