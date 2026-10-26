import { beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import type { OnboardingJob } from '@/lib/onboarding/jobs'

import { useOnboardingStore } from '../onboarding-store'

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
  taskId: 'diffusion:z-image-q4',
  phase: 'queued',
}

const saved = () =>
  JSON.parse(localStorage.getItem(localStorageKey.onboarding) ?? '{}').state

describe('onboarding store', () => {
  beforeEach(() => {
    useOnboardingStore.getState().reset()
    localStorage.clear()
  })

  it('starts a run once, and resumes it instead of restarting', () => {
    const store = useOnboardingStore.getState()
    store.begin('full', 'welcome')
    const startedAt = useOnboardingStore.getState().startedAt
    store.goTo('cloud')
    store.begin('full', 'welcome')

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'active',
      step: 'cloud',
      startedAt,
    })
  })

  it('queues the chat model ahead of image and video jobs added before it', () => {
    const store = useOnboardingStore.getState()
    const video = { ...image, key: 'ltx-2', title: 'LTX-2' }
    store.enqueue(image)
    store.enqueue(video)
    store.enqueue(chat)

    expect(useOnboardingStore.getState().jobs.map((job) => job.key)).toEqual([
      'chat',
      'z-image',
      'ltx-2',
    ])

    // Replacing a job keeps its place.
    store.enqueue({ ...image, phase: 'running' })
    expect(useOnboardingStore.getState().jobs[1]).toMatchObject({
      key: 'z-image',
      phase: 'running',
    })
  })

  it('keeps the step, the choice and the queue for the next launch', async () => {
    const store = useOnboardingStore.getState()
    store.begin('full', 'welcome')
    store.goTo('backend')
    store.choose({
      source: 'download',
      provider: 'llamacpp-upstream',
      modelId: 'Qwen3.5-4B-Q4_K_M',
      title: 'Qwen3.5 4B',
      matchIds: ['Qwen3.5-4B-Q4_K_M'],
    })
    store.enqueue(chat)
    store.enqueue(image)

    expect(saved()).toMatchObject({
      phase: 'active',
      step: 'backend',
      choice: { modelId: 'Qwen3.5-4B-Q4_K_M' },
      jobs: [{ key: 'chat' }, { key: 'z-image' }],
    })

    // A relaunch hydrates from storage.
    const persisted = localStorage.getItem(localStorageKey.onboarding)
    store.reset()
    localStorage.setItem(localStorageKey.onboarding, persisted!)
    await useOnboardingStore.persist.rehydrate()

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'active',
      step: 'backend',
      jobs: [{ key: 'chat' }, { key: 'z-image' }],
    })
  })

  it('replaces a job with the same key and removes one on request', () => {
    const store = useOnboardingStore.getState()
    store.enqueue(image)
    store.enqueue({ ...image, phase: 'running' })
    expect(useOnboardingStore.getState().jobs).toEqual([
      { ...image, phase: 'running' },
    ])

    store.setJobPhase('z-image', 'done')
    expect(useOnboardingStore.getState().jobs[0].phase).toBe('done')

    store.dequeue('z-image')
    expect(useOnboardingStore.getState().jobs).toEqual([])
  })

  it('opens the server hints on a server handoff, and none for chat', () => {
    const store = useOnboardingStore.getState()
    store.begin('full', 'welcome')
    store.dismissPanel()
    store.handOff('endpoint')

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'handedOff',
      destination: 'endpoint',
      guide: { path: 'endpoint', hint: 0 },
      panelDismissed: false,
    })

    store.handOff('chat')
    expect(useOnboardingStore.getState().guide).toBeNull()
  })

  it('goes back to setup only from a handoff', () => {
    const store = useOnboardingStore.getState()
    store.reopen()
    expect(useOnboardingStore.getState().phase).toBe('idle')

    store.begin('full', 'welcome')
    store.handOff('chat')
    store.reopen()
    expect(useOnboardingStore.getState().phase).toBe('active')
  })

  it('finishes with the hints closed', () => {
    const store = useOnboardingStore.getState()
    store.begin('full', 'welcome')
    store.handOff('agents')
    store.finish()

    expect(useOnboardingStore.getState()).toMatchObject({
      phase: 'finished',
      guide: null,
    })
  })

  it('keeps each cloud provider connected in the run once, in order', () => {
    const store = useOnboardingStore.getState()
    store.begin('full', 'cloud')
    store.connectCloud('openrouter')
    store.connectCloud('chatgpt')
    store.connectCloud('openrouter')

    expect(useOnboardingStore.getState().clouds).toEqual([
      'openrouter',
      'chatgpt',
    ])
    expect(saved().clouds).toEqual(['openrouter', 'chatgpt'])

    store.reset()
    expect(useOnboardingStore.getState().clouds).toEqual([])
  })

  it('records each permission answer', () => {
    const store = useOnboardingStore.getState()
    store.setPermission('notifications', 'granted')
    store.setPermission('microphone', 'denied')

    expect(useOnboardingStore.getState().permissions).toEqual({
      notifications: 'granted',
      microphone: 'denied',
    })
  })
})
