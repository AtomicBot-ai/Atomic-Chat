import { useEffect, useMemo, useState } from 'react'
import debounce from 'lodash.debounce'
import { EngineManager, type AIEngine } from '@janhq/core'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'

/** Providers whose models expose a `ctx_len` knob the app can restart with. */
export const LOCAL_CONTEXT_PROVIDERS = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
])
const FALLBACK_MAX_CONTEXT = 512 * 1024

type NumericControllerProps = ControllerProps & {
  min?: number
  max?: number
  step?: number
}

export function formatContextSize(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}M`
  if (value >= 1024) return `${(value / 1024).toFixed(1)}K`
  return value.toString()
}

/**
 * The selected local model's context length as an editable value: a draft the
 * slider drags, the resolved slider bounds (the engine's trained maximum when
 * it reports one), and `commit`, which persists the value and restarts the
 * model if it is loaded. `available` is false for providers with no context
 * knob, in which case the rest is inert.
 */
export function useModelContextLength() {
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const selectedModel = useModelProvider((state) => state.selectedModel)
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const getProviderByName = useModelProvider(
    (state) => state.getProviderByName
  )
  const serviceHub = useServiceHub()

  const contextValue = Number(
    selectedModel?.settings?.ctx_len?.controller_props?.value
  )
  const selectedContextProps = selectedModel?.settings?.ctx_len
    ?.controller_props as NumericControllerProps | undefined
  const configuredMax = Number(selectedContextProps?.max)
  const fallbackMaxContext = Math.max(
    FALLBACK_MAX_CONTEXT,
    configuredMax > 0 ? configuredMax : 0
  )
  const [maxContext, setMaxContext] = useState(fallbackMaxContext)
  const [draft, setDraft] = useState(contextValue > 0 ? contextValue : 0)

  const restartModel = useMemo(
    () =>
      debounce(async (modelId: string, providerName: string) => {
        try {
          await serviceHub.models().stopModel(modelId)
          const freshProvider =
            useModelProvider.getState().getProviderByName(providerName)
          if (freshProvider) {
            await serviceHub.models().startModel(freshProvider, modelId, true)
          }
          const activeModels = await serviceHub.models().getActiveModels()
          syncActiveModelsFromEngines(activeModels || [])
        } catch (error) {
          console.error(
            'Failed to restart model after context size change:',
            error
          )
        }
      }, 500),
    [serviceHub]
  )

  useEffect(() => () => restartModel.cancel(), [restartModel])

  useEffect(() => {
    const currentValue = Number(
      selectedModel?.settings?.ctx_len?.controller_props?.value
    )
    setDraft(currentValue > 0 ? currentValue : 0)
    setMaxContext(fallbackMaxContext)

    if (!selectedProvider || !selectedModel) return

    let cancelled = false
    const resolveMaxContext = async () => {
      let resolvedMax = fallbackMaxContext
      try {
        const engine = EngineManager.instance().get(selectedProvider) as
          | (AIEngine & {
              getMaxCtxTrain?: (id: string) => Promise<number | undefined>
            })
          | undefined
        if (engine && typeof engine.getMaxCtxTrain === 'function') {
          const modelMax = await engine.getMaxCtxTrain(selectedModel.id)
          if (typeof modelMax === 'number' && modelMax > 0) {
            resolvedMax = modelMax
          }
        }
      } catch (error) {
        console.warn(
          `Failed to resolve maximum context for ${selectedProvider}/${selectedModel?.id}:`,
          error
        )
      }
      if (!cancelled) setMaxContext(resolvedMax)
    }

    void resolveMaxContext()
    return () => {
      cancelled = true
    }
  }, [configuredMax, fallbackMaxContext, selectedModel, selectedProvider])

  const provider = selectedProvider
    ? getProviderByName(selectedProvider)
    : undefined
  const contextSetting = selectedModel?.settings?.ctx_len as
    | ProviderSetting
    | undefined
  const available = Boolean(
    selectedProvider &&
      LOCAL_CONTEXT_PROVIDERS.has(selectedProvider) &&
      selectedModel &&
      provider &&
      contextSetting
  )

  const contextControllerProps = (contextSetting?.controller_props ??
    {}) as NumericControllerProps
  const currentContext = Number(contextControllerProps.value) || 0
  const sliderMin = Math.max(1, Number(contextControllerProps.min) || 1024)
  const sliderMax = Math.max(sliderMin, currentContext, maxContext || 0)
  const sliderStep = Math.max(1, Number(contextControllerProps.step) || 1024)

  const commit = (value: string | boolean | number) => {
    if (!available || !provider || !selectedModel || !contextSetting) return
    const modelIndex = provider.models.findIndex(
      (model) => model.id === selectedModel.id
    )
    if (modelIndex === -1) return

    const updatedModels = [...provider.models]
    updatedModels[modelIndex] = {
      ...selectedModel,
      settings: {
        ...selectedModel.settings,
        ctx_len: {
          ...contextSetting,
          controller_props: {
            ...contextSetting.controller_props,
            value,
          },
        },
      },
    } as Model

    updateProvider(provider.provider, { models: updatedModels })

    serviceHub
      .models()
      .getActiveModels()
      .then((activeModels) => {
        if (activeModels.includes(selectedModel.id)) {
          restartModel(selectedModel.id, provider.provider)
        }
      })
      .catch((error) => {
        console.error('Failed to check active models:', error)
      })
  }

  return {
    available,
    provider,
    selectedModel,
    contextSetting,
    draft,
    setDraft,
    commit,
    sliderMin,
    sliderMax,
    sliderStep,
  }
}
