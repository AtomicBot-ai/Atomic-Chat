import { describe, expect, it } from 'vitest'

import { EMBEDDING_MODEL_ID } from '@/constants/models'

import {
  findChatModel,
  ggufMatchIds,
  handoffPanelContent,
  handoffPanelTracksJobs,
  jobView,
  mlxMatchIds,
  nextRunnable,
  queueSettled,
  type DownloadSnapshot,
  type OnboardingJob,
} from '../jobs'

const chat: OnboardingJob = {
  key: 'chat',
  kind: 'chat',
  title: 'Qwen3.5 4B',
  taskId: 'Qwen3.5-4B-Q4_K_M',
  totalBytes: 2_700_000_000,
  phase: 'running',
}
const image: OnboardingJob = {
  key: 'z-image',
  kind: 'image',
  title: 'Z-Image Turbo',
  taskId: 'diffusion:z-image-q4',
  phase: 'queued',
}
const video: OnboardingJob = { ...image, key: 'ltx-2', title: 'LTX-2' }

const idle: DownloadSnapshot = { downloads: {}, pausedDownloads: new Set() }
const at = (progress: number, current = 1): DownloadSnapshot => ({
  downloads: {
    [chat.taskId]: { progress, current, total: 2_700_000_000 },
  },
  pausedDownloads: new Set(),
})

describe('onboarding job view', () => {
  it('reads progress from the download store, floored and never 100 before done', () => {
    expect(jobView(chat, at(0.4237))).toMatchObject({
      state: 'downloading',
      percent: 42,
      totalBytes: 2_700_000_000,
    })
    expect(jobView(chat, at(0.999)).percent).toBe(99)
  })

  it('says preparing until the first byte arrives', () => {
    expect(jobView(chat, idle)).toMatchObject({
      state: 'preparing',
      percent: 0,
      totalBytes: 2_700_000_000,
    })
    expect(jobView(chat, at(0, 0)).state).toBe('preparing')
  })

  it('shows Pause as paused, keeping the progress made', () => {
    const paused = { ...at(0.5), pausedDownloads: new Set([chat.taskId]) }
    expect(jobView(chat, paused)).toMatchObject({
      state: 'paused',
      percent: 50,
    })
  })

  it('shows a failed job as interrupted with its progress', () => {
    expect(jobView({ ...chat, phase: 'failed' }, at(0.3))).toMatchObject({
      state: 'interrupted',
      percent: 30,
    })
  })

  it('shows a finished job as done even after its download row is gone', () => {
    expect(jobView({ ...chat, phase: 'done' }, idle)).toMatchObject({
      state: 'done',
      percent: 100,
      currentBytes: 2_700_000_000,
    })
  })

  it('keeps a waiting job queued whatever the store says', () => {
    expect(jobView(image, idle).state).toBe('queued')
  })

  const stopped: OnboardingJob = {
    ...chat,
    phase: 'failed',
    stoppedAt: {
      taskId: chat.taskId,
      progress: 0.4137,
      current: 1_117_000_000,
      total: 2_700_000_000,
    },
  }

  it('keeps where an interrupted transfer stopped once its row is gone', () => {
    expect(jobView(stopped, idle)).toMatchObject({
      state: 'interrupted',
      percent: 41,
      progress: 0.4137,
      currentBytes: 1_117_000_000,
      totalBytes: 2_700_000_000,
    })
  })

  it('keeps it through a Retry until the resumed transfer reports', () => {
    const retried = { ...stopped, phase: 'running' as const }
    expect(jobView(retried, idle)).toMatchObject({
      state: 'downloading',
      percent: 41,
    })
    expect(jobView(retried, at(0.45, 1_215_000_000))).toMatchObject({
      state: 'downloading',
      percent: 45,
      currentBytes: 1_215_000_000,
    })
  })

  it("never lends one transfer's progress to another", () => {
    expect(
      jobView({ ...stopped, taskId: 'diffusion-backend-metal' }, idle)
    ).toMatchObject({ state: 'interrupted', percent: 0, currentBytes: 0 })
  })
})

describe('onboarding queue', () => {
  it('runs one job at a time, in order', () => {
    expect(nextRunnable([chat, image, video])).toBeNull()
    expect(nextRunnable([{ ...chat, phase: 'done' }, image, video])).toBe(image)
  })

  it('holds the queue behind a failed job until it is retried', () => {
    expect(nextRunnable([{ ...chat, phase: 'failed' }, image])).toBeNull()
  })

  it('has nothing to run once everything is done', () => {
    const done = [chat, image].map((job) => ({
      ...job,
      phase: 'done' as const,
    }))
    expect(nextRunnable(done)).toBeNull()
    expect(queueSettled(done)).toBe(true)
    expect(queueSettled([{ ...chat, phase: 'done' }, image])).toBe(false)
    expect(queueSettled([])).toBe(true)
  })
})

describe('finding the chosen chat model', () => {
  const choice = {
    provider: 'llamacpp-upstream',
    matchIds: ggufMatchIds('unsloth', 'Qwen3.5-4B-Q4_K_M'),
  }

  it('matches the id the importer registers a Hub download under', () => {
    expect(choice.matchIds).toEqual([
      'Qwen3.5-4B-Q4_K_M',
      'unsloth/Qwen3_5-4B-Q4_K_M',
    ])
    expect(
      findChatModel(choice, [
        {
          provider: 'llamacpp-upstream',
          models: [{ id: 'unsloth/Qwen3_5-4B-Q4_K_M' }],
        },
      ])
    ).toEqual({
      provider: 'llamacpp-upstream',
      modelId: 'unsloth/Qwen3_5-4B-Q4_K_M',
    })
  })

  it('keeps the dots an MLX id keeps', () => {
    expect(
      mlxMatchIds('mlx-community', 'mlx-community/Qwen3.5 4B 4bit')
    ).toEqual(['Qwen3.5-4B-4bit', 'mlx-community/Qwen3.5-4B-4bit'])
  })

  it('is not ready while the model is missing, broken or behind a switched-off provider', () => {
    expect(findChatModel(choice, [])).toBeNull()
    expect(findChatModel(null, [])).toBeNull()
    expect(
      findChatModel(choice, [
        {
          provider: 'llamacpp-upstream',
          models: [{ id: 'Qwen3.5-4B-Q4_K_M', missing: true }],
        },
      ])
    ).toBeNull()
    expect(
      findChatModel(choice, [
        {
          provider: 'llamacpp-upstream',
          active: false,
          models: [{ id: 'Qwen3.5-4B-Q4_K_M' }],
        },
      ])
    ).toBeNull()
  })

  it('never takes the embedding model for the chat model', () => {
    expect(
      findChatModel(
        { provider: 'llamacpp-upstream', matchIds: [EMBEDDING_MODEL_ID] },
        [
          {
            provider: 'llamacpp-upstream',
            models: [{ id: EMBEDDING_MODEL_ID }],
          },
        ]
      )
    ).toBeNull()
  })
})

describe('the handoff panel', () => {
  const run = {
    phase: 'handedOff',
    destination: 'chat',
    panelDismissed: false,
    jobs: [chat, image],
  }

  it('follows the downloads after a handoff to the chat until they settle', () => {
    expect(handoffPanelTracksJobs(run)).toBe(true)
    expect(
      handoffPanelTracksJobs({ ...run, jobs: [{ ...chat, phase: 'failed' }] })
    ).toBe(true)
    expect(
      handoffPanelTracksJobs({ ...run, jobs: [{ ...chat, phase: 'done' }] })
    ).toBe(false)
    expect(handoffPanelTracksJobs({ ...run, jobs: [] })).toBe(false)
  })

  it('leaves them to the setup screen, the server pages or a dismissal', () => {
    expect(handoffPanelTracksJobs({ ...run, phase: 'active' })).toBe(false)
    expect(handoffPanelTracksJobs({ ...run, destination: 'endpoint' })).toBe(
      false
    )
    expect(handoffPanelTracksJobs({ ...run, panelDismissed: true })).toBe(false)
  })

  const settled = { ...run, jobs: [{ ...chat, phase: 'done' as const }] }

  it('says the model is ready once the downloads are over, or were before the handoff', () => {
    const here = { ready: true, seenInApp: true }
    expect(handoffPanelContent(run, here)).toBe('downloads')
    expect(handoffPanelContent(settled, here)).toBe('ready')
    expect(handoffPanelContent({ ...run, jobs: [] }, here)).toBe('ready')
    expect(
      handoffPanelContent(settled, { ready: false, seenInApp: true })
    ).toBeNull()
  })

  it('says nothing after a dismissal, a server handoff or at a later launch', () => {
    const here = { ready: true, seenInApp: true }
    expect(
      handoffPanelContent({ ...settled, panelDismissed: true }, here)
    ).toBeNull()
    expect(
      handoffPanelContent({ ...settled, destination: 'agents' }, here)
    ).toBeNull()
    expect(
      handoffPanelContent({ ...settled, phase: 'active' }, here)
    ).toBeNull()
    expect(
      handoffPanelContent(settled, { ready: true, seenInApp: false })
    ).toBeNull()
    // Downloads still running are followed at any launch.
    expect(handoffPanelContent(run, { ready: false, seenInApp: false })).toBe(
      'downloads'
    )
  })
})
