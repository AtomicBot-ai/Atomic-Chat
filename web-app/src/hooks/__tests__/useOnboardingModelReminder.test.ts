import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localStorageKey } from '@/constants/localStorage'

const state = vi.hoisted(() => ({
  providers: [] as Array<{
    provider: string
    api_key?: string
    models: Array<{ id: string }>
  }>,
  localDownloadingModels: new Set<string>(),
}))

vi.mock('../useModelProvider', () => ({
  useModelProvider: () => ({ providers: state.providers }),
}))

vi.mock('../useDownloadStore', () => ({
  useDownloadStore: () => ({
    localDownloadingModels: state.localDownloadingModels,
  }),
}))

import {
  useOnboardingModelReminder,
  useOnboardingModelReminderStore,
} from '../useOnboardingModelReminder'

const withModel = (id: string) => [
  { provider: 'llamacpp-upstream', models: [{ id }] },
]

describe('useOnboardingModelReminder', () => {
  beforeEach(() => {
    localStorage.clear()
    state.providers = []
    state.localDownloadingModels = new Set()
    useOnboardingModelReminderStore.setState({ pending: false })
  })

  const setup = () => renderHook(() => useOnboardingModelReminder())

  it('stays hidden while onboarding has never been left', () => {
    expect(setup().result.current.showOnboardingModelReminder).toBe(false)
  })

  it('shows once onboarding was left without a model', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    useOnboardingModelReminderStore.setState({ pending: true })

    expect(setup().result.current.showOnboardingModelReminder).toBe(true)
  })

  it('stays hidden while the setup screen would still be showing', () => {
    useOnboardingModelReminderStore.setState({ pending: true })

    expect(setup().result.current.showOnboardingModelReminder).toBe(false)
  })

  it.each([
    'AtomicChat/Qwen3_5-4B-Q4_K_M',
    'AtomicChat/Qwen3.5-4B-IQ4_XS',
    'Qwen3.5-4B-GGUF',
  ])('stays hidden once %s is in the library', (id) => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    useOnboardingModelReminderStore.setState({ pending: true })
    state.providers = withModel(id)

    const { result } = setup()
    expect(result.current.isReminderModelDownloaded).toBe(true)
    expect(result.current.showOnboardingModelReminder).toBe(false)
  })

  it('ignores a cloud catalog that lists the same model', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    useOnboardingModelReminderStore.setState({ pending: true })
    state.providers = [
      {
        provider: 'openrouter',
        api_key: 'sk-test',
        models: [{ id: 'qwen/qwen3.5-4b' }],
      },
    ]

    const { result } = setup()
    expect(result.current.isReminderModelDownloaded).toBe(false)
    expect(result.current.showOnboardingModelReminder).toBe(true)
  })

  it('still shows for an unrelated local model', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    useOnboardingModelReminderStore.setState({ pending: true })
    state.providers = withModel('unsloth/gemma-4-E2B-it-Q4_K_M')

    const { result } = setup()
    expect(result.current.isReminderModelDownloaded).toBe(false)
    expect(result.current.showOnboardingModelReminder).toBe(true)
  })

  it('stays hidden while the recommended model is downloading', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    useOnboardingModelReminderStore.setState({ pending: true })
    state.localDownloadingModels = new Set(['AtomicChat/Qwen3.5-4B-Q4_K_M'])

    const { result } = setup()
    expect(result.current.isDownloading).toBe(true)
    expect(result.current.showOnboardingModelReminder).toBe(false)
  })

  it('never returns after being cleared', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    useOnboardingModelReminderStore.setState({ pending: true })

    const { result } = setup()
    act(() => result.current.setPending(false))

    expect(result.current.showOnboardingModelReminder).toBe(false)
  })
})
