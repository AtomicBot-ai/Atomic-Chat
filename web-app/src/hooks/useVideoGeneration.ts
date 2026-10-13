import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/shallow'

import { parseSeedText } from '@/hooks/useImageForm'
import { useMediaTarget } from '@/hooks/useMediaTarget'
import {
  useRemoteMediaTarget,
  type ResolvedRemoteTarget,
} from '@/hooks/useRemoteMedia'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
import { useVideoEstimate } from '@/hooks/useVideoEstimate'
import { useVideoForm } from '@/hooks/useVideoForm'
import { previewVideoCapabilities } from '@/lib/diffusion/capabilities'
import {
  effectiveVideoOptions,
  nominalVideoSize,
} from '@/lib/media-capabilities'
import type {
  VideoCapabilities,
  VideoEstimate,
  VideoGenerateRequest,
  VideoJob,
} from '@/services/diffusion/types'
import type {
  RemoteVideoOptions,
  VideoModelDescriptor,
} from '@/services/media/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'

/** Why Generate is disabled, as a `videos:form.disabled.<reason>` key. */
export type VideoGenerateDisabledReason =
  | 'noEngine'
  | 'noModel'
  | 'modelLoading'
  | 'emptyPrompt'
  | 'noSource'
  | 'unsupportedWorkflow'
  | 'busy'

/** What `ConfirmVideoExceedsMemory` renders from. */
export type VideoExceedsConfirmation = {
  open: boolean
  /** Kept through the closing animation so the figures do not blank out. */
  estimate: VideoEstimate | null
  onCancel: () => void
  onConfirm: () => void
}

type PendingLaunch = {
  estimate: VideoEstimate
  request: VideoGenerateRequest
  seed: number | null
}

export type VideoGenerationHandle = {
  generating: boolean
  job: VideoJob | null
  stopRequested: boolean
  /** The resident model is this page's video model and its capabilities are known. */
  modelReady: boolean
  /** The checkpoint Generate runs, started first when it is stopped. */
  targetArtifactId: string | null
  /** Its family, whose numbers the form holds. */
  targetFamilyId: string | null
  /** The core's report once the target is resident, the catalog's preview before. */
  capabilities: VideoCapabilities | null
  canGenerate: boolean
  disabledReason: VideoGenerateDisabledReason | null
  /** The request the form would submit right now. */
  request: VideoGenerateRequest
  seed: number | null
  /** The core's estimate of the draft; null while there is none. */
  estimate: VideoEstimate | null
  /** Asked before a draft whose estimate exceeds memory starts. */
  confirmation: VideoExceedsConfirmation
  /** The picked provider model, which Generate sends to instead of the local engine. */
  remote: ResolvedRemoteTarget<VideoModelDescriptor> | null
  /** What the request carries for it: the form's settings checked against the model. */
  remoteOptions: RemoteVideoOptions | null
  generate: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Bridges the persisted Video form and the video job store: builds the
 * request, decides whether Generate is allowed (and why not), keeps the
 * core's estimate of the draft, and forwards the two verbs. Busy means
 * either page is generating: the two share one engine session. A picked
 * model that is not running does not block Generate: Generate starts it.
 *
 * A draft the core says exceeds memory is not started straight away: the
 * `confirmation` asks first, Cancel is its default answer, and "Generate
 * anyway" starts exactly the draft that was asked about.
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
  const target = useMediaTarget('video')
  const remote = useRemoteMediaTarget('video')
  const remoteForm = useRemoteMediaForm(
    useShallow((state) => ({
      options: state.video,
      workflow: state.videoWorkflow,
      firstFrame: state.firstFrame,
    }))
  )
  const remoteOptions = useMemo(
    () =>
      remote
        ? effectiveVideoOptions(remote.descriptor, remoteForm.options)
        : null,
    [remote, remoteForm.options]
  )
  const {
    status,
    residentCapabilities,
    loadingArtifactId,
    imageGenerating,
    loadModel,
  } = useImageGenerationStore(
    useShallow((state) => ({
      status: state.status,
      residentCapabilities: state.videoCapabilities,
      loadingArtifactId: state.loadingArtifactId,
      imageGenerating: state.generating,
      loadModel: state.loadModel,
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
  const targetArtifactId = target.artifactId
  const targetFamily = targetArtifactId ? target.artifact.family : null
  const modelReady =
    targetArtifactId !== null &&
    status?.model.state === 'loaded' &&
    loaded?.modality === 'video' &&
    loaded.modelId === targetArtifactId &&
    residentCapabilities !== null
  const previewCapabilities = useMemo(
    () => (targetFamily ? previewVideoCapabilities(targetFamily) : null),
    [targetFamily]
  )
  const capabilities = modelReady ? residentCapabilities : previewCapabilities
  // The target is resident but its report is still being read (a start from
  // elsewhere, the app launching): starting it again would be a reload.
  const readingResident =
    targetArtifactId !== null &&
    status?.model.loaded?.modelId === targetArtifactId &&
    residentCapabilities === null

  const seed = parseSeedText(form.seedText)

  const request = useMemo<VideoGenerateRequest>(() => {
    const trimmedNegative = form.negativePrompt.trim()
    if (remote && remoteOptions) {
      // A provider's clip: its length and shape are the remote settings; the size is nominal,
      // for the pending tile — the provider's own file says what it made.
      const { params } = remote.descriptor
      const size = nominalVideoSize(remoteOptions)
      const workflow = remoteForm.workflow
      return {
        prompt: form.prompt.trim(),
        ...(params.negative_prompt && trimmedNegative
          ? { negativePrompt: trimmedNegative }
          : {}),
        width: size.width,
        height: size.height,
        steps: 0,
        cfgScale: 0,
        workflow,
        ...(workflow === 'image-to-video' && remoteForm.firstFrame
          ? { initImage: { path: remoteForm.firstFrame.path } }
          : {}),
        target: remote.target,
        remote: remoteOptions,
      }
    }
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
  }, [
    form,
    capabilities,
    remote,
    remoteOptions,
    remoteForm.workflow,
    remoteForm.firstFrame,
  ])

  // The core estimates the local engine only; a provider's clip has no estimate here.
  const estimates = useVideoEstimate(
    request,
    !remote && modelReady ? (loaded?.modelId ?? null) : null
  )
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pending, setPending] = useState<PendingLaunch | null>(null)

  const remoteDisabled: VideoGenerateDisabledReason | null = !remote
    ? null
    : generating
      ? 'busy'
      : !remote.descriptor.workflows.some((w) => w === remoteForm.workflow)
        ? 'unsupportedWorkflow'
        : remoteForm.workflow === 'image-to-video' && !remoteForm.firstFrame
          ? 'noSource'
          : request.prompt.length === 0 && !request.initImage
            ? 'emptyPrompt'
            : null

  const disabledReason: VideoGenerateDisabledReason | null = remote
    ? remoteDisabled
    : generating || imageGenerating
      ? 'busy'
      : !engineInstalled
        ? 'noEngine'
        : loadingArtifactId || readingResident
          ? 'modelLoading'
          : targetArtifactId === null
            ? 'noModel'
            : request.prompt.length === 0
              ? 'emptyPrompt'
              : null

  const { current } = estimates
  const generate = useCallback(async () => {
    if (disabledReason) return
    // A provider's model has nothing to start and no memory to ask about.
    if (remote) {
      await startGeneration({ request, seed })
      return
    }
    if (targetArtifactId === null) return
    if (!modelReady) {
      // Start the picked model first. A failed start leaves its error on
      // the page and nothing is submitted.
      await loadModel(targetArtifactId)
      const after = useImageGenerationStore.getState()
      if (
        after.status?.model.loaded?.modelId !== targetArtifactId ||
        after.videoCapabilities === null
      )
        return
    }
    const estimate = await current(targetArtifactId)
    if (estimate?.memory.verdict === 'exceeds') {
      setPending({ estimate, request, seed })
      setConfirmOpen(true)
      return
    }
    await startGeneration({ request, seed })
  }, [
    disabledReason,
    remote,
    targetArtifactId,
    modelReady,
    loadModel,
    current,
    startGeneration,
    request,
    seed,
  ])

  const onCancel = useCallback(() => setConfirmOpen(false), [])
  const onConfirm = useCallback(() => {
    setConfirmOpen(false)
    if (pending)
      void startGeneration({ request: pending.request, seed: pending.seed })
  }, [pending, startGeneration])

  return {
    generating,
    job: currentJob,
    stopRequested,
    modelReady,
    targetArtifactId,
    // A provider's model adopts the form like a family of its own.
    targetFamilyId: remote
      ? `remote:${remote.target.provider}/${remote.target.model}`
      : target.familyId,
    capabilities: remote ? null : capabilities,
    canGenerate: disabledReason === null,
    disabledReason,
    request,
    seed,
    estimate: estimates.estimate,
    confirmation: {
      open: confirmOpen,
      estimate: pending?.estimate ?? null,
      onCancel,
      onConfirm,
    },
    remote,
    remoteOptions,
    generate,
    stop,
  }
}
