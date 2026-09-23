import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'

import { parseSeedText } from '@/hooks/useImageForm'
import { useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import type { VideoGenerateRequest, VideoJob } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'

/** Why Generate is disabled, as a `videos:form.disabled.<reason>` key. */
export type VideoGenerateDisabledReason =
  | 'noEngine'
  | 'noModel'
  | 'modelLoading'
  | 'emptyPrompt'
  | 'busy'

export type VideoGenerationHandle = {
  generating: boolean
  job: VideoJob | null
  stopRequested: boolean
  /** The resident model is this page's video model and its capabilities are known. */
  modelReady: boolean
  canGenerate: boolean
  disabledReason: VideoGenerateDisabledReason | null
  /** The request the form would submit right now. */
  request: VideoGenerateRequest
  seed: number | null
  generate: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Bridges the persisted Video form and the video job store: builds the
 * request, decides whether Generate is allowed (and why not), and forwards
 * the two verbs. No state of its own. Busy means either page is generating:
 * the two share one engine session.
 */
export function useVideoGeneration(): VideoGenerationHandle {
  const form = useVideoForm(
    useShallow((state) => ({
      prompt: state.prompt,
      negativePrompt: state.negativePrompt,
      width: state.width,
      height: state.height,
      frames: state.frames,
      steps: state.steps,
      cfgScale: state.cfgScale,
      guidance: state.guidance,
      seedText: state.seedText,
    }))
  )
  const selectedArtifactId = useVideoSetting(
    (state) => state.selectedArtifactId
  )
  const { status, capabilities, loadingArtifactId, imageGenerating } =
    useImageGenerationStore(
      useShallow((state) => ({
        status: state.status,
        capabilities: state.videoCapabilities,
        loadingArtifactId: state.loadingArtifactId,
        imageGenerating: state.generating,
      }))
    )
  const { currentJob, stopRequested, generating, startGeneration, stop } =
    useVideoGenerationStore(
      useShallow((state) => ({
        currentJob: state.currentJob,
        stopRequested: state.stopRequested,
        generating: state.generating,
        startGeneration: state.startGeneration,
        stop: state.stop,
      }))
    )

  const engineInstalled = status?.install.state === 'installed'
  const loaded = status?.model.loaded ?? null
  const modelReady =
    status?.model.state === 'loaded' &&
    loaded?.modality === 'video' &&
    capabilities !== null &&
    (selectedArtifactId === null || loaded.modelId === selectedArtifactId)

  const seed = parseSeedText(form.seedText)

  const request = useMemo<VideoGenerateRequest>(() => {
    const trimmedNegative = form.negativePrompt.trim()
    return {
      prompt: form.prompt.trim(),
      ...(capabilities?.supportsNegativePrompt && trimmedNegative
        ? { negativePrompt: trimmedNegative }
        : {}),
      width: form.width,
      height: form.height,
      frames: form.frames,
      ...(capabilities ? { fps: capabilities.fps } : {}),
      steps: form.steps,
      cfgScale: form.cfgScale,
      ...(capabilities?.supportsGuidance && form.guidance !== null
        ? { guidance: form.guidance }
        : {}),
      ...(capabilities?.defaults.samplingMethod
        ? { samplingMethod: capabilities.defaults.samplingMethod }
        : {}),
      ...(capabilities?.defaults.flowShift !== undefined
        ? { flowShift: capabilities.defaults.flowShift }
        : {}),
      workflow: 'create',
    }
  }, [form, capabilities])

  const disabledReason: VideoGenerateDisabledReason | null =
    generating || imageGenerating
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
    await startGeneration({ request, seed })
  }, [disabledReason, startGeneration, request, seed])

  return {
    generating,
    job: currentJob,
    stopRequested,
    modelReady,
    canGenerate: disabledReason === null,
    disabledReason,
    request,
    seed,
    generate,
    stop,
  }
}
