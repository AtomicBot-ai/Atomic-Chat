import '@/test/telemetry-ready'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  abortDownload: vi.fn(async () => {}),
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    models: () => ({ abortDownload: mocks.abortDownload }),
  }),
}))

import { OnboardingHandoffPanel } from '../OnboardingHandoffPanel'

const chat: OnboardingJob = {
  key: 'chat',
  kind: 'chat',
  title: 'Qwen3.5 4B',
  taskId: 'Qwen3.5-4B-Q4_K_M',
  phase: 'running',
}
const image: OnboardingJob = {
  key: 'z-image',
  kind: 'image',
  title: 'Z-Image Turbo',
  taskId: 'diffusion-model-z-image_q4',
  phase: 'queued',
}

const handOffWith = (jobs: OnboardingJob[]) => {
  const store = useOnboardingStore.getState()
  store.begin('full', 'model')
  store.choose({
    source: 'download',
    provider: 'llamacpp-upstream',
    modelId: chat.taskId,
    title: chat.title,
    matchIds: [chat.taskId],
  })
  jobs.forEach((job) => store.enqueue(job))
  store.handOff('chat')
}

const phaseOf = (key: string) =>
  useOnboardingStore.getState().jobs.find((job) => job.key === key)?.phase

const GB = 1024 ** 3

describe('OnboardingHandoffPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useOnboardingStore.getState().reset()
    useModelProvider.setState({ providers: [] } as never)
    useDownloadStore.setState({
      downloads: {
        [chat.taskId]: {
          id: chat.taskId,
          name: chat.taskId,
          progress: 0.42,
          current: 42,
          total: 100,
        },
      },
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
      resumeParams: {},
    } as never)
    useUpdateBannerSlots.setState({
      claimed: { app: false, engine: false },
    })
  })

  it('shows the download in flight, with how many wait behind it', () => {
    handOffWith([chat, image])
    render(<OnboardingHandoffPanel />)

    const panel = screen.getByRole('region', {
      name: 'onboarding-handoff:panel.label',
    })
    expect(within(panel).getByText(chat.title)).toBeInTheDocument()
    expect(within(panel).getByText('42%')).toBeInTheDocument()
    expect(panel).toHaveTextContent('onboarding:download.withQueued')
    expect(
      within(panel).queryByRole('button', {
        name: 'onboarding-handoff:panel.backToSetup',
      })
    ).not.toBeInTheDocument()
  })

  it('is put away with Dismiss', () => {
    handOffWith([chat])
    render(<OnboardingHandoffPanel />)

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-handoff:panel.dismiss' })
    )

    expect(useOnboardingStore.getState().panelDismissed).toBe(true)
    // The download itself carries on.
    expect(phaseOf(chat.key)).toBe('running')
  })

  it('pauses the chat download from the panel', () => {
    handOffWith([chat])
    render(<OnboardingHandoffPanel />)

    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding:download.pause' })
    )

    expect(useDownloadStore.getState().pausedDownloads.has(chat.taskId)).toBe(
      true
    )
    expect(
      screen.getByRole('button', { name: 'onboarding:download.resume' })
    ).toBeInTheDocument()
    expect(mocks.abortDownload).toHaveBeenCalledWith(chat.taskId)
  })

  it('offers Retry on an interrupted image job, which queues it again', () => {
    handOffWith([
      { ...chat, phase: 'done' },
      { ...image, phase: 'failed' },
    ])
    render(<OnboardingHandoffPanel />)

    expect(
      screen.getByText('onboarding:download.interrupted')
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'onboarding-handoff:retryLabel' })
    )

    expect(phaseOf(image.key)).toBe('queued')
    expect(screen.getByText('onboarding:download.queued')).toBeInTheDocument()
  })

  it('keeps how far an interrupted download got, with the queue behind it', () => {
    // The failure took the row out of the download store.
    useDownloadStore.setState({ downloads: {} })
    handOffWith([
      {
        ...chat,
        phase: 'failed',
        totalBytes: 2.7 * GB,
        stoppedAt: {
          taskId: chat.taskId,
          progress: 0.4137,
          current: 0.4137 * 2.7 * GB,
          total: 2.7 * GB,
        },
      },
      image,
    ])
    render(<OnboardingHandoffPanel />)

    const panel = screen.getByTestId('onboarding-handoff')
    expect(within(panel).getByText('41%')).toBeInTheDocument()
    expect(
      within(panel).getByRole('progressbar', {
        name: 'onboarding:download.progress Qwen3.5 4B',
      })
    ).toHaveAttribute('aria-valuenow', '41')
    expect(panel).toHaveTextContent(
      'onboarding:download.withQueued onboarding:download.interrupted · 1.12 / 2.70 GB 1'
    )
  })

  it('keeps the progress of a paused download', () => {
    useDownloadStore.setState({
      downloads: {
        [chat.taskId]: {
          id: chat.taskId,
          name: chat.taskId,
          progress: 0.42,
          current: 0.42 * 2.7 * GB,
          total: 2.7 * GB,
        },
      },
      pausedDownloads: new Set([chat.taskId]),
    } as never)
    handOffWith([chat])
    render(<OnboardingHandoffPanel />)

    const panel = screen.getByTestId('onboarding-handoff')
    expect(within(panel).getByText('42%')).toBeInTheDocument()
    expect(panel).toHaveTextContent(
      'common:downloadPanel.paused · 1.13 / 2.70 GB'
    )
  })

  it('gives the corner to an update banner only when it just says the model is ready', () => {
    handOffWith([chat])
    act(() => useUpdateBannerSlots.getState().setSlotVisible('app', true))

    const { rerender } = render(<OnboardingHandoffPanel yieldsCorner />)
    expect(screen.queryByTestId('onboarding-handoff')).not.toBeInTheDocument()

    rerender(<OnboardingHandoffPanel />)
    expect(screen.getByTestId('onboarding-handoff')).toBeInTheDocument()

    rerender(<OnboardingHandoffPanel yieldsCorner />)
    act(() => useUpdateBannerSlots.getState().setSlotVisible('app', false))
    expect(screen.getByTestId('onboarding-handoff')).toBeInTheDocument()
  })

  it('says the model is ready once it is', () => {
    handOffWith([{ ...chat, phase: 'done' }])
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [{ id: chat.taskId }],
        },
      ],
    } as never)
    render(<OnboardingHandoffPanel />)

    expect(
      screen.getByText('onboarding:download.ready Qwen3.5 4B')
    ).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
