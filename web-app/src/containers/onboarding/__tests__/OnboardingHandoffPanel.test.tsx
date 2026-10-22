import { fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { route } from '@/constants/routes'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  abortDownload: vi.fn(async () => {}),
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
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
      within(panel).getByRole('button', {
        name: 'onboarding-handoff:panel.backToSetup',
      })
    ).toBeInTheDocument()
  })

  it('goes back to setup through the setup route', () => {
    handOffWith([chat])
    render(<OnboardingHandoffPanel />)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'onboarding-handoff:panel.backToSetup',
      })
    )

    expect(mocks.navigate).toHaveBeenCalledWith({ to: route.onboarding })
    // Re-opening the run is the route's; the panel only navigates.
    expect(useOnboardingStore.getState().phase).toBe('handedOff')
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
