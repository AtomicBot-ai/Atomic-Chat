import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))
const mlx = vi.hoisted(() => ({ installMlxEngine: vi.fn() }))
vi.mock('@/services/engine-builds/mlx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engine-builds/mlx')>()),
  ...mlx,
}))

import { useMlxEngineInstallStore } from '@/services/engine-builds/mlx'
import type { EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

import { MlxEngineSetupCard } from '../MlxEngineSetupCard'

const versions = (over: Partial<EngineVersions> = {}): EngineVersions => ({
  engine: 'mlx',
  kind: 'engine-build',
  active_choice: 'core',
  builds: [],
  active: null,
  latest: { version: 'mlxvlm-macos-arm64-abc1234', variant: 'macos-arm64' },
  update: { needed: false, target: null, apply: 'swap' },
  source: 'remote',
  source_error: null,
  error: null,
  ...over,
})

const hold = (entry: EngineVersions | undefined) =>
  useEngineVersionsStore.setState({ engines: entry ? { mlx: entry } : {} })

beforeEach(() => {
  vi.clearAllMocks()
  useMlxEngineInstallStore.setState({ installing: false, progress: null })
})

describe('MlxEngineSetupCard', () => {
  it('says what the engine is and installs it in one click', () => {
    hold(versions())
    mlx.installMlxEngine.mockResolvedValue({ installed: true })

    render(<MlxEngineSetupCard />)

    expect(screen.getByTestId('mlx-engine-setup')).toHaveTextContent(
      'settings:mlxEngine.setup.description'
    )
    // The core sizes only a build it offers as an update.
    expect(screen.queryByTestId('mlx-engine-size')).toBeNull()
    fireEvent.click(screen.getByTestId('mlx-engine-install'))
    expect(mlx.installMlxEngine).toHaveBeenCalledTimes(1)
  })

  it('names the download size when the core knows it', () => {
    hold(
      versions({
        latest: {
          version: 'mlxvlm-macos-arm64-abc1234',
          variant: 'macos-arm64',
          download_bytes: 210 * 1024 ** 2,
        },
      })
    )

    render(<MlxEngineSetupCard />)

    expect(screen.getByTestId('mlx-engine-size')).toHaveTextContent(
      'settings:mlxEngine.setup.size {"size":"210.0 MB"}'
    )
  })

  it('shows an install running anywhere, with its progress, and waits for it', () => {
    hold(versions())
    useMlxEngineInstallStore.setState({
      installing: true,
      progress: { transferred: 21, total: 84 },
    })

    render(<MlxEngineSetupCard />)

    expect(screen.getByTestId('mlx-engine-install')).toBeDisabled()
    expect(screen.getByTestId('mlx-engine-progress')).toHaveTextContent(
      'settings:mlxEngine.setup.progress {"percent":25}'
    )

    // Before the download reports bytes, the line says what is going on.
    act(() => useMlxEngineInstallStore.setState({ progress: null }))
    expect(screen.getByTestId('mlx-engine-progress')).toHaveTextContent(
      'settings:mlxEngine.installingEngine'
    )
  })

  it('says why an install failed, and nothing about a cancelled one', async () => {
    hold(versions())
    mlx.installMlxEngine.mockRejectedValueOnce({
      code: 'CANCELLED',
      message: 'Download cancelled',
    })
    render(<MlxEngineSetupCard />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('mlx-engine-install'))
    })
    expect(screen.queryByRole('alert')).toBeNull()

    mlx.installMlxEngine.mockRejectedValueOnce({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'sha256 mismatch',
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('mlx-engine-install'))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('sha256 mismatch')
  })

  it('renders nothing once MLX has a build, and nothing before the core answered', () => {
    hold(versions({ active: { version: 'v1', variant: 'macos-arm64' } }))
    const { container, rerender } = render(<MlxEngineSetupCard />)
    expect(container).toBeEmptyDOMElement()

    act(() => hold(undefined))
    rerender(<MlxEngineSetupCard />)
    expect(container).toBeEmptyDOMElement()
  })
})
