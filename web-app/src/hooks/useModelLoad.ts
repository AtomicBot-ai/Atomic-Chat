import { create } from 'zustand'

type ModelLoadState = {
  modelLoadError?: string | ErrorObject
  // Which model `modelLoadError` belongs to (the error carries no id).
  modelLoadErrorModelId?: string
  setModelLoadError: (
    error: string | ErrorObject | undefined,
    modelId?: string
  ) => void
  onboardingActive: boolean
  setOnboardingActive: (value: boolean) => void
}

export const useModelLoad = create<ModelLoadState>()((set) => ({
  modelLoadError: undefined,
  modelLoadErrorModelId: undefined,
  setModelLoadError: (error, modelId) =>
    set({
      modelLoadError: error,
      modelLoadErrorModelId: error ? modelId : undefined,
    }),
  onboardingActive: false,
  setOnboardingActive: (value) => set({ onboardingActive: value }),
}))
