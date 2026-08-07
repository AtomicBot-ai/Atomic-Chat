import { localStorageKey } from '@/constants/localStorage'
import { ONBOARDING_REMINDER_MODEL_HF_REPO } from '@/constants/models'
import { isLocalProvider } from '@/utils/registerRemoteProvider'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { useDownloadStore } from './useDownloadStore'
import { useModelProvider } from './useModelProvider'
import { useSetupCompleted } from './useSetupCompleted'

export type OnboardingModelReminderState = {
  /// Onboarding was left without a model, so the bottom-right reminder still
  /// owes the user the recommended download. Cleared on dismiss or download.
  pending: boolean
  setPending: (value: boolean) => void
}

export const useOnboardingModelReminderStore =
  create<OnboardingModelReminderState>()(
    persist(
      (set) => ({
        pending: false,
        setPending: (value: boolean) => set({ pending: value }),
      }),
      {
        name: localStorageKey.onboardingModelReminder,
        storage: createJSONStorage(() => localStorage),
      }
    )
  )

/// Model ids reach the provider registry through `sanitizeModelId`, which turns
/// dots into underscores, and quant suffixes vary per download. Comparing on
/// alphanumerics only keeps `Qwen3.5-4B-Q4_K_M` and `Qwen3_5-4B-IQ4_XS` equal.
const normalizeModelId = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, '')

const REMINDER_MODEL_TOKEN = normalizeModelId(
  ONBOARDING_REMINDER_MODEL_HF_REPO.split('/').pop()!.replace(/-GGUF$/i, '')
)

const matchesReminderModel = (id: string) =>
  normalizeModelId(id).includes(REMINDER_MODEL_TOKEN)

export const useOnboardingModelReminder = () => {
  const pending = useOnboardingModelReminderStore((state) => state.pending)
  const setPending = useOnboardingModelReminderStore(
    (state) => state.setPending
  )
  const { providers } = useModelProvider()
  const { localDownloadingModels } = useDownloadStore()
  const setupCompleted = useSetupCompleted()

  // Local providers only: a cloud catalog listing its own Qwen3.5 4B entry says
  // nothing about whether the user has a model on disk to talk to.
  const isReminderModelDownloaded = providers.some(
    (provider) =>
      isLocalProvider(provider.provider) &&
      provider.models.some((model: { id: string }) =>
        matchesReminderModel(model.id)
      )
  )

  const isDownloading = Array.from(localDownloadingModels).some(
    matchesReminderModel
  )

  const showOnboardingModelReminder =
    pending &&
    // `pending` is only ever armed together with this flag, so requiring it
    // keeps the reminder off the setup screen itself.
    setupCompleted &&
    !isReminderModelDownloaded &&
    !isDownloading

  return {
    showOnboardingModelReminder,
    setPending,
    isReminderModelDownloaded,
    isDownloading,
  }
}
