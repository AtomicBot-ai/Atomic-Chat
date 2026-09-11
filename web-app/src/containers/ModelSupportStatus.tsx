import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getJanDataFolderPath, joinPath, fs } from '@janhq/core'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useAppState } from '@/hooks/useAppState'
import { useModelLoad } from '@/hooks/useModelLoad'

interface ModelSupportStatusProps {
  modelId: string | undefined
  provider: string | undefined
  contextSize: number
  className?: string
}

type DeviceFit = 'RED' | 'YELLOW' | 'GREEN' | 'GREY' | null

/**
 * The dot next to the selected model: what its engine is doing right now.
 *
 * Green means running and nothing else. It used to double as the llama.cpp
 * "fits in memory" estimate, so a stopped model that fit stayed green and a
 * Stop looked like it had done nothing. The estimate still colours a model
 * that is not running when it warns (yellow / red), and is spelled out in the
 * tooltip otherwise.
 */
export const ModelSupportStatus = ({
  modelId,
  provider,
  contextSize,
  className,
}: ModelSupportStatusProps) => {
  const serviceHub = useServiceHub()
  const isModelRunning = useAppState(
    (state) => !!modelId && state.activeModels.includes(modelId)
  )
  const loadingModel = useAppState((state) => state.loadingModel)
  const modelLoadError = useModelLoad((state) => state.modelLoadError)
  const modelLoadErrorModelId = useModelLoad(
    (state) => state.modelLoadErrorModelId
  )
  const [deviceFit, setDeviceFit] = useState<{
    key: string
    fit: DeviceFit
  } | null>(null)

  const isLlamacpp = provider === 'llamacpp' || provider === 'llamacpp-upstream'
  const isLocalEngine = isLlamacpp || provider === 'mlx'

  // This model's load failed terminally — outranks the memory-fit estimate so
  // a model that fits RAM but the backend can't parse isn't shown as fine.
  const loadFailed =
    !!modelId &&
    modelLoadErrorModelId === modelId &&
    !!modelLoadError &&
    !loadingModel &&
    !isModelRunning

  // Helper function to check model support with proper path resolution
  const checkModelSupportWithPath = useCallback(
    async (id: string, ctxSize: number): Promise<DeviceFit> => {
      try {
        const janDataFolder = await getJanDataFolderPath()

        // First try the standard downloaded model path
        const ggufModelPath = await joinPath([
          janDataFolder,
          'llamacpp',
          'models',
          id,
          'model.gguf',
        ])

        // Check if the standard model.gguf file exists
        if (await fs.existsSync(ggufModelPath)) {
          return await serviceHub.models().isModelSupported(ggufModelPath, ctxSize)
        }

        // If model.gguf doesn't exist, try reading from model.yml (for imported models)
        const modelConfigPath = await joinPath([
          janDataFolder,
          'llamacpp',
          'models',
          id,
          'model.yml',
        ])

        if (!(await fs.existsSync(modelConfigPath))) {
          console.error(
            `Neither model.gguf nor model.yml found for model: ${id}`
          )
          return null
        }

        // Read the model configuration to get the actual model path
        const modelConfig = await serviceHub.app().readYaml<{ model_path: string }>(
          `llamacpp/models/${id}/model.yml`
        )

        // Handle both absolute and relative paths
        const actualModelPath =
          modelConfig.model_path.startsWith('/') ||
          modelConfig.model_path.match(/^[A-Za-z]:/)
            ? modelConfig.model_path // absolute path, use as-is
            : await joinPath([janDataFolder, modelConfig.model_path]) // relative path, join with data folder

        return await serviceHub.models().isModelSupported(actualModelPath, ctxSize)
      } catch (error) {
        console.error(
          'Error checking model support with path resolution:',
          error
        )
        // If path construction or model support check fails, assume not supported
        return null
      }
    },
    [serviceHub]
  )

  // llama.cpp hardware-compatibility estimate. Both the TurboQuant fork
  // ('llamacpp') and the upstream build ('llamacpp-upstream') consume the same
  // GGUF tree under <jan>/llamacpp/models/ — see `getModelsRootPath()` in the
  // llamacpp-upstream extension — so the same probe applies to both.
  //
  // Keyed on the running flag rather than the `activeModels` array: every
  // engine re-sync writes a fresh array, and re-probing on each one flashed a
  // spinner over a status that had not changed. A running model is not probed
  // at all — its own weights occupy the memory the estimate would count.
  useEffect(() => {
    if (!isLlamacpp || !modelId || isModelRunning) return

    let cancelled = false
    const key = `${modelId}:${contextSize}`
    checkModelSupportWithPath(modelId, contextSize).then((fit) => {
      if (!cancelled) setDeviceFit({ key, fit })
    })
    return () => {
      cancelled = true
    }
  }, [
    isLlamacpp,
    modelId,
    contextSize,
    isModelRunning,
    checkModelSupportWithPath,
  ])

  if (!modelId || !isLocalEngine) return null

  // A result for another model or context size says nothing about this one.
  const fit =
    isLlamacpp && deviceFit?.key === `${modelId}:${contextSize}`
      ? deviceFit.fit
      : null

  const status = isModelRunning
    ? 'running'
    : loadFailed
      ? 'failed'
      : loadingModel
        ? 'starting'
        : fit === 'RED'
          ? 'wontFit'
          : fit === 'YELLOW'
            ? 'mightNotFit'
            : 'stopped'

  const tooltip = {
    running: 'Model is running',
    // Not a memory/ctx problem, so outrank the fit wording below.
    failed: 'Model failed to load on this backend',
    starting: 'Starting model…',
    wontFit: `Model is not running — doesn't work on your device (ctx: ${contextSize})`,
    mightNotFit: `Model is not running — might work on your device (ctx: ${contextSize})`,
    stopped:
      fit === 'GREEN'
        ? `Model is not running — works well on your device (ctx: ${contextSize})`
        : 'Model is not running',
  }[status]

  const indicator = {
    running: 'bg-green-500',
    failed: 'bg-red-500',
    starting: 'size-2.5 border border-t-transparent animate-spin',
    wontFit: 'bg-red-500',
    mightNotFit: 'bg-yellow-500',
    stopped: 'border border-muted-foreground',
  }[status]

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'size-2 flex items-center justify-center rounded-full',
              indicator,
              className
            )}
            data-testid="model-status-indicator"
            data-status={status}
            aria-label={tooltip}
          />
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
