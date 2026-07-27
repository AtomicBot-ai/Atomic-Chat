import { useEffect, useMemo, useState } from 'react'
import debounce from 'lodash.debounce'
import {
  EngineManager,
  type AIEngine,
  type ThreadMessage,
} from '@janhq/core'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTokensCount } from '@/hooks/useTokensCount'
import { cn } from '@/lib/utils'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'

const LOCAL_CONTEXT_PROVIDERS = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
])

interface ContextSizeControlProps {
  messages?: ThreadMessage[]
  additionalTokens?: number
  uploadedFiles?: Array<{
    name: string
    type: string
    size: number
    base64: string
    dataUrl: string
  }>
}

type NumericControllerProps = ControllerProps & {
  min?: number
  max?: number
  step?: number
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toString()
}

function formatContextSize(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}M`
  if (value >= 1024) return `${(value / 1024).toFixed(1)}K`
  return value.toString()
}

export function ContextSizeControl({
  messages = [],
  additionalTokens = 0,
  uploadedFiles = [],
}: ContextSizeControlProps) {
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const selectedModel = useModelProvider((state) => state.selectedModel)
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const getProviderByName = useModelProvider(
    (state) => state.getProviderByName
  )
  const serviceHub = useServiceHub()
  const tokenData = useTokensCount(messages, uploadedFiles)
  const totalTokens = tokenData.tokenCount + additionalTokens
  const percentage = tokenData.maxTokens
    ? (totalTokens / tokenData.maxTokens) * 100
    : 0
  const isOverLimit = percentage > 100
  const contextValue = Number(
    selectedModel?.settings?.ctx_len?.controller_props?.value
  )
  const selectedContextProps = selectedModel?.settings?.ctx_len
    ?.controller_props as NumericControllerProps | undefined
  const configuredMax = Number(
    selectedContextProps?.max
  )
  const [maxContext, setMaxContext] = useState<number | undefined>(
    configuredMax > 0 ? configuredMax : undefined
  )
  const [draftContext, setDraftContext] = useState(
    contextValue > 0 ? contextValue : 0
  )

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
    setDraftContext(currentValue > 0 ? currentValue : 0)
    setMaxContext(configuredMax > 0 ? configuredMax : undefined)

    if (!selectedProvider || !selectedModel) return

    let cancelled = false
    const resolveMaxContext = async () => {
      let resolvedMax = configuredMax > 0 ? configuredMax : undefined
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
  }, [configuredMax, selectedModel, selectedProvider])

  if (
    !selectedProvider ||
    !LOCAL_CONTEXT_PROVIDERS.has(selectedProvider) ||
    !selectedModel
  ) {
    return null
  }

  const provider = getProviderByName(selectedProvider)
  const contextSetting = selectedModel.settings?.ctx_len as
    | ProviderSetting
    | undefined

  if (!provider || !contextSetting) return null

  const contextControllerProps =
    contextSetting.controller_props as NumericControllerProps
  const currentContext = Number(contextControllerProps.value) || 0
  const sliderMin = Math.max(1, Number(contextControllerProps.min) || 1024)
  const sliderMax = Math.max(sliderMin, currentContext, maxContext || 0)
  const sliderStep = Math.max(1, Number(contextControllerProps.step) || 1024)

  const handleContextChange = (value: string | boolean | number) => {
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

  const percentageLabel = `${percentage.toFixed(1)}%`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-2 px-2 font-mono text-xs"
          aria-label={`Context usage: ${percentageLabel}`}
        >
          <span className={cn(isOverLimit && 'text-destructive')}>
            {percentageLabel}
          </span>
          <span className="relative size-4 shrink-0">
            <svg className="size-4 -rotate-90" viewBox="0 0 16 16">
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                className="text-muted-foreground"
              />
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeDasharray={`${2 * Math.PI * 6}`}
                strokeDashoffset={`${2 * Math.PI * 6 * (1 - Math.min(percentage, 100) / 100)}`}
                className={cn(
                  'transition-all duration-500 ease-out',
                  isOverLimit ? 'stroke-destructive' : 'stroke-primary'
                )}
                style={{ transformOrigin: 'center' }}
              />
            </svg>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span
              className={cn(
                'text-lg font-semibold tabular-nums',
                isOverLimit ? 'text-destructive' : 'text-primary'
              )}
            >
              {percentageLabel}
            </span>
            <span className="font-mono text-sm text-muted-foreground">
              {formatTokenCount(totalTokens)} /{' '}
              {formatTokenCount(tokenData.maxTokens || 0)}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary/20">
            <div
              className={cn(
                'h-2 rounded-full transition-all duration-500 ease-out',
                isOverLimit ? 'bg-destructive' : 'bg-primary'
              )}
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Text</span>
            <span className="font-mono text-foreground">
              {formatTokenCount(Math.max(0, tokenData.tokenCount))}
            </span>
          </div>
          <div className="flex items-center justify-between border-b border-border pb-3 text-sm">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-mono font-semibold text-foreground">
              {formatTokenCount(
                Math.max(0, (tokenData.maxTokens || 0) - totalTokens)
              )}
            </span>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-medium">{contextSetting.title}</div>
              <div className="font-mono text-xs tabular-nums">
                {formatContextSize(draftContext)}
              </div>
            </div>
            {contextSetting.description && (
              <div className="text-xs text-muted-foreground">
                {contextSetting.description}
              </div>
            )}
          </div>
          <Slider
            aria-label={contextSetting.title}
            className="w-full"
            value={[Math.min(Math.max(draftContext, sliderMin), sliderMax)]}
            min={sliderMin}
            max={sliderMax}
            step={sliderStep}
            disabled={!maxContext}
            onValueChange={([value]) => setDraftContext(value)}
            onValueCommit={([value]) => handleContextChange(value)}
          />
          <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>{formatContextSize(sliderMin)}</span>
            <span>{formatContextSize(sliderMax)}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
