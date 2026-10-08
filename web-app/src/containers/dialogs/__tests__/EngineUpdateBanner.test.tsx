import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import EngineUpdateBanner from '@/containers/dialogs/EngineUpdateBanner'
import { isEngineUpdateSnoozed } from '@/lib/engineUpdateOffer'
import type { EngineId, EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'

const open = vi.fn()
const navigate = vi.fn()

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open }) }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

// Every swap goes to the core.
const updateEngineWithProgress = vi.hoisted(() => vi.fn())
vi.mock('@/services/engines/update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/engines/update')>()),
  updateEngineWithProgress,
}))

// The media engine's update runs through the image store, which calls the core.
const imageStore = vi.hoisted(() => ({ updateEngine: vi.fn() }))
vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: { getState: () => imageStore },
}))

const versions = (
  engine: EngineId,
  active: string,
  target: string,
  patch: Partial<EngineVersions> = {}
): EngineVersions => {
  const [activeVersion, activeVariant] = active.split('/')
  const [targetVersion, targetVariant] = target.split('/')
  return {
    engine,
    kind: 'llamacpp',
    active_choice: 'client',
    builds: [],
    active: { version: activeVersion, variant: activeVariant },
    latest: { version: targetVersion, variant: targetVariant },
    update: {
      needed: true,
      target: {
        version: targetVersion,
        variant: targetVariant,
        download_bytes: 11 * 1024 * 1024,
      },
      apply: 'swap',
    },
    source: 'remote',
    source_error: null,
    error: null,
    ...patch,
  }
}

const UPSTREAM = versions(
  'llamacpp-upstream',
  'b10840/macos-arm64',
  'b10909/macos-arm64'
)
const MEDIA = versions(
  'sd-cpp',
  'master-849-d04e895/macos-arm64',
  'master-900-abc1234/macos-arm64',
  { kind: 'engine-build', active_choice: 'core' }
)
const MLX = versions(
  'mlx',
  'mlxvlm-macos-arm64-07ba5a1/macos-arm64',
  'mlxvlm-macos-arm64-abc1234/macos-arm64',
  { kind: 'engine-build', active_choice: 'core' }
)

const hold = (...entries: EngineVersions[]) =>
  act(() => {
    useEngineVersionsStore.setState({
      engines: Object.fromEntries(entries.map((e) => [e.engine, e])),
    })
  })

describe('EngineUpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useEngineVersionsStore.getState().reset()
    useUpdateBannerSlots.setState({
      claimed: { download: false, app: false, engine: false },
    })
    open.mockResolvedValue(undefined)
    updateEngineWithProgress.mockResolvedValue({
      updated: true,
      active: { version: 'b10909', variant: 'macos-arm64' },
      retired: [],
      kept_in_use: [],
    })
    imageStore.updateEngine.mockResolvedValue(undefined)
  })

  it('renders nothing when the core offers no engine update', () => {
    hold({
      ...UPSTREAM,
      update: { ...UPSTREAM.update, needed: false, blocked_reason: 'unstable' },
    })
    const { container } = render(<EngineUpdateBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the engine, the version transition and what the update costs', async () => {
    hold(UPSTREAM)
    render(<EngineUpdateBanner />)

    expect(await screen.findByText('updater:engine.title')).toBeInTheDocument()
    expect(screen.getByText('b10840')).toBeInTheDocument()
    expect(screen.getByText('b10909')).toBeInTheDocument()
    expect(
      screen.getByText(
        'updater:engine.downloadSize · updater:engine.noRestartNeeded'
      )
    ).toBeInTheDocument()
  })

  it('picks up an offer the core makes after it mounted', async () => {
    render(<EngineUpdateBanner />)
    expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()

    hold(UPSTREAM)

    expect(await screen.findByText('updater:engine.title')).toBeInTheDocument()
  })

  it('updates through the core only once the user accepts, and steps aside', async () => {
    const user = userEvent.setup()
    hold(UPSTREAM)
    render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    expect(updateEngineWithProgress).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(updateEngineWithProgress).toHaveBeenCalledWith('llamacpp-upstream', {
      taskId: 'engine-update-llamacpp-upstream-b10909',
    })
    // The transfer's progress belongs to the download panel, so the banner
    // steps aside instead of growing a progress bar.
    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
  })

  it('updates PrismML through the core too', async () => {
    const user = userEvent.setup()
    hold(
      versions(
        'atomic-prism',
        'prism-b9000-abcdef0/macos-arm64',
        'prism-b9100-1234567/macos-arm64'
      )
    )
    render(<EngineUpdateBanner />)

    expect(await screen.findByText('prism-b9100-1234567')).toBeInTheDocument()
    // Its release page is in its own manifest, not in the core's answer.
    expect(
      screen.queryByRole('button', { name: 'updater:engine.showWhatsNew' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(updateEngineWithProgress).toHaveBeenCalledWith('atomic-prism', {
      taskId: 'engine-update-atomic-prism-prism-b9100-1234567',
    })
  })

  it('shows the error and offers the update again when the core refuses it', async () => {
    const user = userEvent.setup()
    updateEngineWithProgress.mockRejectedValue({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'download failed',
    })
    hold(UPSTREAM)
    render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(await screen.findByText('updater:engine.title')).toBeInTheDocument()
  })

  it('brings the offer back later after "Remind me later"', async () => {
    const user = userEvent.setup()
    hold(UPSTREAM)
    render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    await user.click(
      screen.getByRole('button', { name: 'updater:remindMeLater' })
    )

    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
    expect(
      isEngineUpdateSnoozed(
        {
          provider: 'llamacpp-upstream',
          targetBackend: 'b10909/macos-arm64',
        } as never,
        Date.now()
      )
    ).toBe(true)
  })

  it('never offers a dismissed build again', async () => {
    const user = userEvent.setup()
    hold(UPSTREAM)
    const { unmount } = render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    await user.click(screen.getByRole('button', { name: 'updater:dismiss' }))
    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
    unmount()

    render(<EngineUpdateBanner />)
    expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
  })

  it('opens the engine release page for "Show what\'s new"', async () => {
    const user = userEvent.setup()
    hold(UPSTREAM)
    render(<EngineUpdateBanner />)

    await screen.findByText('updater:engine.title')
    await user.click(
      screen.getByRole('button', { name: 'updater:engine.showWhatsNew' })
    )

    expect(open.mock.calls).toEqual([
      ['https://github.com/ggml-org/llama.cpp/releases/tag/b10909'],
    ])
    // Reading the notes is not an answer to the offer.
    expect(screen.getByText('updater:engine.title')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'updater:update' })).toBeEnabled()
    expect(updateEngineWithProgress).not.toHaveBeenCalled()
  })

  it('stands down while the app-update banner holds the corner', async () => {
    hold(UPSTREAM)
    useUpdateBannerSlots.setState({
      claimed: { download: false, app: true, engine: false },
    })
    render(<EngineUpdateBanner />)

    await waitFor(() =>
      expect(screen.queryByText('updater:engine.title')).not.toBeInTheDocument()
    )
  })

  it('updates the media engine through the image store once the user accepts', async () => {
    const user = userEvent.setup()
    hold(MEDIA)
    render(<EngineUpdateBanner />)

    expect(await screen.findByText('master-900-abc1234')).toBeInTheDocument()
    expect(imageStore.updateEngine).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(imageStore.updateEngine).toHaveBeenCalledTimes(1)
    expect(updateEngineWithProgress).not.toHaveBeenCalled()
  })

  it('updates MLX through the core under its engine-update task', async () => {
    const user = userEvent.setup()
    hold(MLX)
    render(<EngineUpdateBanner />)

    expect(
      await screen.findByText('mlxvlm-macos-arm64-abc1234')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(updateEngineWithProgress).toHaveBeenCalledWith('mlx', {
      taskId: 'engine-update-mlx-mlxvlm-macos-arm64-abc1234',
    })
  })

  it('puts MLX behind llama.cpp and ahead of the media engine', async () => {
    hold(MEDIA, MLX)
    const first = render(<EngineUpdateBanner />)
    expect(
      await screen.findByText('mlxvlm-macos-arm64-abc1234')
    ).toBeInTheDocument()
    first.unmount()

    hold(MEDIA, MLX, UPSTREAM)
    render(<EngineUpdateBanner />)
    expect(await screen.findByText('b10909')).toBeInTheDocument()
    expect(
      screen.queryByText('mlxvlm-macos-arm64-abc1234')
    ).not.toBeInTheDocument()
  })

  it('takes a managed engine to its page to confirm the reinstall', async () => {
    const user = userEvent.setup()
    hold(
      versions('vllm', 'vllm-0.31.0-r1/linux', 'vllm-0.32.0-r1/linux', {
        kind: 'managed',
        active_choice: 'core',
        active: { version: 'vllm-0.31.0-r1', variant: 'linux/amd64' },
        update: {
          needed: true,
          target: { version: 'vllm-0.32.0-r1', variant: 'linux/amd64' },
          apply: 'reinstall',
        },
      })
    )
    render(<EngineUpdateBanner />)

    await screen.findByText('vllm-0.32.0-r1')
    await user.click(screen.getByRole('button', { name: 'updater:update' }))

    expect(updateEngineWithProgress).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'vllm' },
      search: { engineUpdate: true },
    })
    // Nothing began: the offer stays until the reinstall is confirmed.
    expect(screen.getByText('updater:engine.title')).toBeInTheDocument()
  })
})
