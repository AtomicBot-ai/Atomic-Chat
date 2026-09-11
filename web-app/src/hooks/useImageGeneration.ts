import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'

import { parseSeedText, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import type { ImageGenerateRequest, ImageJob } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'

/** Why Generate is disabled, as an `images:form.disabled.<reason>` key. */
export type GenerateDisabledReason =
  | 'noEngine'
  | 'noModel'
  | 'modelLoading'
  | 'emptyPrompt'
  | 'busy'

export type ImageGenerationHandle = {
  generating: boolean
  job: ImageJob | null
  runsTotal: number
  runsDone: number
  stopRequested: boolean
  /** The resident model is this one and its capabilities are known. */
  modelReady: boolean
  canGenerate: boolean
  disabledReason: GenerateDisabledReason | null
  /** The request the form would submit right now. */
  request: ImageGenerateRequest
  baseSeed: number | null
  generate: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Bridges the persisted form and the generation store: builds the request,
 * decides whether Generate is allowed (and why not), and forwards the two
 * verbs. No state of its own.
 */
export function useImageGeneration(): ImageGenerationHandle {
  const form = useImageForm(
    useShallow((state) => ({
      prompt: state.prompt,
      negativePrompt: state.negativePrompt,
      width: state.width,
      height: state.height,
      steps: state.steps,
      cfgScale: state.cfgScale,
      guidance: state.guidance,
      seedText: state.seedText,
      batchSize: state.batchSize,
      runs: state.runs,
      workflow: state.workflow,
    }))
  )
  const selectedArtifactId = useImageSetting(
    (state) => state.selectedArtifactId
  )
  const {
    status,
    capabilities,
    currentJob,
    runsTotal,
    runsDone,
    stopRequested,
    generating,
    loadingArtifactId,
    startGeneration,
    stop,
  } = useImageGenerationStore(
    useShallow((state) => ({
      status: state.status,
      capabilities: state.capabilities,
      currentJob: state.currentJob,
      runsTotal: state.runsTotal,
      runsDone: state.runsDone,
      stopRequested: state.stopRequested,
      generating: state.generating,
      loadingArtifactId: state.loadingArtifactId,
      startGeneration: state.startGeneration,
      stop: state.stop,
    }))
  )

  const engineInstalled = status?.install.state === 'installed'
  const loadedId = status?.model.loaded?.modelId ?? null
  const modelReady =
    status?.model.state === 'loaded' &&
    capabilities !== null &&
    (selectedArtifactId === null || loadedId === selectedArtifactId)

  const baseSeed = parseSeedText(form.seedText)

  const request = useMemo<ImageGenerateRequest>(() => {
    const trimmedNegative = form.negativePrompt.trim()
    return {
      prompt: form.prompt.trim(),
      negativePrompt:
        capabilities?.supportsNegativePrompt && trimmedNegative
          ? trimmedNegative
          : undefined,
      width: form.width,
      height: form.height,
      steps: form.steps,
      cfgScale: form.cfgScale,
      guidance:
        capabilities?.supportsGuidance && form.guidance !== null
          ? form.guidance
          : undefined,
      batchSize: form.batchSize,
      samplingMethod: capabilities?.defaults.samplingMethod,
      flowShift: capabilities?.defaults.flowShift,
      workflow: form.workflow,
    }
  }, [form, capabilities])

  const disabledReason: GenerateDisabledReason | null = generating
    ? 'busy'
    : !engineInstalled
      ? 'noEngine'
      : loadingArtifactId
        ? 'modelLoading'
        : !modelReady
          ? 'noModel'
          : request.prompt.length === 0
            ? 'emptyPrompt'
            : null

  const generate = useCallback(async () => {
    if (disabledReason) return
    await startGeneration({ request, runs: form.runs, baseSeed })
  }, [disabledReason, startGeneration, request, form.runs, baseSeed])

  return {
    generating,
    job: currentJob,
    runsTotal,
    runsDone,
    stopRequested,
    modelReady,
    canGenerate: disabledReason === null,
    disabledReason,
    request,
    baseSeed,
    generate,
    stop,
  }
}
