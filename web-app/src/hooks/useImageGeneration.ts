import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'

import { readFileBytes } from '@/lib/readFileBytes'
import { drawOutpaint, loadImage } from '@/containers/images/canvas'
import { parseSeedText, useImageForm } from '@/hooks/useImageForm'
import { useMediaTarget } from '@/hooks/useMediaTarget'
import {
  useRemoteMediaTarget,
  type ResolvedRemoteTarget,
} from '@/hooks/useRemoteMedia'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
import {
  effectiveImageOptions,
  parseSize,
  remoteImageCapabilities,
} from '@/lib/media-capabilities'
import type { ImageModelDescriptor } from '@/services/media/types'
import { previewImageCapabilities } from '@/lib/diffusion/capabilities'
import { workflowNeedsLlmVision } from '@/lib/diffusion/models'
import { anySide, outpaintGeometry } from '@/lib/diffusion/outpaint'
import { fitWithin, scaleWithin, type DimConstraints } from '@/lib/diffusion/size'
import { MAX_SOURCE_IMAGE_BYTES, workflowSpec } from '@/lib/diffusion/workflows'
import type {
  ImageCapabilities,
  ImageGenerateRequest,
  ImageJob,
} from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'

/** Why Generate is disabled, as an `images:form.disabled.<reason>` key. */
export type GenerateDisabledReason =
  | 'noEngine'
  | 'noModel'
  | 'modelLoading'
  | 'emptyPrompt'
  | 'noSource'
  | 'noMask'
  | 'noSides'
  | 'unsupportedWorkflow'
  | 'busy'

export type ImageGenerationHandle = {
  generating: boolean
  job: ImageJob | null
  runsTotal: number
  runsDone: number
  stopRequested: boolean
  /** The resident model is this one and its capabilities are known. */
  modelReady: boolean
  /** The checkpoint Generate runs, started first when it is stopped. */
  targetArtifactId: string | null
  /** Its family, whose numbers the form holds. */
  targetFamilyId: string | null
  /**
   * What the target can do: the core's report once it is resident, the
   * catalog's preview of it before, so the form is shaped for the model
   * from the moment it is picked.
   */
  capabilities: ImageCapabilities | null
  canGenerate: boolean
  disabledReason: GenerateDisabledReason | null
  /** The request the form would submit right now (Extend's canvases are built at generate time). */
  request: ImageGenerateRequest
  baseSeed: number | null
  /** The size the job produces, for the form's readouts. */
  outputSize: { width: number; height: number }
  /** The picked provider model, when the form generates with one instead of a local checkpoint. */
  remote: ResolvedRemoteTarget<ImageModelDescriptor> | null
  generate: () => Promise<void>
  stop: () => Promise<void>
}

/** Until a model reports its ranges: sd.cpp's own limits. */
const FALLBACK_CONSTRAINTS: DimConstraints = {
  minDim: 256,
  maxDim: 2048,
  dimMultiple: 16,
}

/**
 * Bridges the persisted form and the generation store: builds the request,
 * decides whether Generate is allowed (and why not), and forwards the two
 * verbs. No state of its own. A picked model that is not running does not
 * block Generate: Generate starts it and then generates.
 *
 * The workflow decides the shape of the request. sd.cpp resizes the init
 * image to the requested size itself, so the size is the one lever:
 * Transform fits the source into the form's resolution, Upscale asks for
 * the source times the factor, Inpaint/Edit keep the source size, Extend
 * sends the grown canvas at its own size.
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
      strength: state.strength,
      expandPercent: state.expandPercent,
      sides: state.sides,
      upscaleFactor: state.upscaleFactor,
      upscaleStrength: state.upscaleStrength,
      sourceImage: state.sourceImage,
      maskBase64: state.maskBase64,
      referenceImages: state.referenceImages,
    }))
  )
  const target = useMediaTarget('image')
  const remote = useRemoteMediaTarget('image')
  const remoteForm = useRemoteMediaForm((state) => state.image)
  const remoteCapabilities = useMemo(
    () => (remote ? remoteImageCapabilities(remote.descriptor) : null),
    [remote]
  )
  const remoteOptions = useMemo(
    () =>
      remote ? effectiveImageOptions(remote.descriptor, remoteForm) : null,
    [remote, remoteForm]
  )
  const {
    status,
    capabilities: residentCapabilities,
    currentJob,
    runsTotal,
    runsDone,
    stopRequested,
    generating,
    loadingArtifactId,
    loadModel,
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
      loadModel: state.loadModel,
      startGeneration: state.startGeneration,
      stop: state.stop,
    }))
  )

  const engineInstalled = status?.install.state === 'installed'
  const targetArtifactId = target.artifactId
  const targetFamily = targetArtifactId ? target.artifact.family : null
  const modelReady =
    targetArtifactId !== null &&
    status?.model.state === 'loaded' &&
    target.artifact.loaded &&
    residentCapabilities !== null
  const previewCapabilities = useMemo(
    () => (targetFamily ? previewImageCapabilities(targetFamily) : null),
    [targetFamily]
  )
  // A provider's model is described by the catalog; nothing needs to be resident.
  const capabilities =
    remoteCapabilities ??
    (modelReady ? residentCapabilities : previewCapabilities)
  // The target is resident but its report is still being read (a start from
  // elsewhere, the app launching): starting it again would be a reload.
  const targetResident =
    targetArtifactId !== null &&
    status?.model.loaded?.modelId === targetArtifactId
  const readingResident = targetResident && residentCapabilities === null
  // Resident without this mode, and a restart would not add it: the one
  // part loaded on demand is a family's vision encoder, for the modes that
  // need it.
  const restartAddsWorkflow =
    workflowNeedsLlmVision(form.workflow) &&
    Boolean(
      targetFamily?.text_encoders.some((file) => file.field === 'llm_vision')
    )
  const residentLacksWorkflow =
    targetResident &&
    residentCapabilities !== null &&
    !residentCapabilities.workflows.includes(form.workflow) &&
    !restartAddsWorkflow

  const baseSeed = parseSeedText(form.seedText)
  const spec = workflowSpec(form.workflow)
  const constraints = useMemo<DimConstraints>(
    () =>
      capabilities
        ? {
            minDim: capabilities.minDim,
            maxDim: capabilities.maxDim,
            dimMultiple: capabilities.dimMultiple,
          }
        : FALLBACK_CONSTRAINTS,
    [capabilities]
  )

  const outputSize = useMemo(() => {
    const source = form.sourceImage
    const formSize = { width: form.width, height: form.height }
    if (remote && remoteCapabilities) {
      // A listed size is the size; a free range is the form's; otherwise the provider decides.
      const listed = parseSize(remoteOptions?.size)
      if (listed) return listed
      if (remote.descriptor.params.size?.kind === 'range') return formSize
      return {
        width: remoteCapabilities.defaults.width,
        height: remoteCapabilities.defaults.height,
      }
    }
    if (!source || !spec.needsSource) return formSize
    switch (form.workflow) {
      case 'transform':
        return fitWithin(source.width, source.height, form.width, form.height, constraints)
      case 'upscale': {
        const scaled = scaleWithin(source.width, source.height, form.upscaleFactor, constraints)
        return { width: scaled.width, height: scaled.height }
      }
      case 'extend': {
        const geometry = outpaintGeometry({
          width: source.width,
          height: source.height,
          expandPercent: form.expandPercent,
          sides: form.sides,
          constraints,
        })
        return { width: geometry.width, height: geometry.height }
      }
      case 'inpaint':
      case 'edit':
        return fitWithin(
          source.width,
          source.height,
          constraints.maxDim,
          constraints.maxDim,
          constraints
        )
      default:
        return formSize
    }
  }, [
    form,
    spec.needsSource,
    constraints,
    remote,
    remoteCapabilities,
    remoteOptions,
  ])

  const request = useMemo<ImageGenerateRequest>(() => {
    const trimmedNegative = form.negativePrompt.trim()
    const source = form.sourceImage
    const base: ImageGenerateRequest = {
      prompt: form.prompt.trim(),
      negativePrompt:
        capabilities?.supportsNegativePrompt && trimmedNegative
          ? trimmedNegative
          : undefined,
      width: outputSize.width,
      height: outputSize.height,
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
    if (remote && remoteCapabilities) {
      const params = remote.descriptor.params
      base.target = remote.target
      base.remote = remoteOptions ?? {}
      base.steps = params.steps ? form.steps : 0
      base.cfgScale = params.cfg ? form.cfgScale : 0
      base.batchSize = Math.min(form.batchSize, remoteCapabilities.maxBatch)
      if (!params.guidance) delete base.guidance
      delete base.samplingMethod
      delete base.flowShift
    }
    if (!spec.needsSource || !source) return base
    switch (form.workflow) {
      case 'transform':
        return { ...base, initImage: { path: source.path }, strength: form.strength }
      case 'inpaint':
        return {
          ...base,
          initImage: { path: source.path },
          maskImage: form.maskBase64 ? { base64: form.maskBase64 } : undefined,
          strength: form.strength,
        }
      case 'extend':
        // The grown canvas and its mask are built when Generate is pressed.
        return { ...base, initImage: { path: source.path }, strength: 1 }
      case 'upscale':
        return { ...base, initImage: { path: source.path }, strength: form.upscaleStrength }
      case 'reference':
        return {
          ...base,
          initImage: { path: source.path },
          referenceImages: form.referenceImages.map((path) => ({ path })),
        }
      case 'edit':
        return { ...base, initImage: { path: source.path } }
      default:
        return base
    }
  }, [
    form,
    capabilities,
    outputSize,
    spec.needsSource,
    remote,
    remoteCapabilities,
    remoteOptions,
  ])

  const remoteDisabled: GenerateDisabledReason | null = !remote
    ? null
    : generating
      ? 'busy'
      : !remote.descriptor.workflows.some((w) => w === form.workflow)
        ? 'unsupportedWorkflow'
        : spec.needsSource && !form.sourceImage
          ? 'noSource'
          : form.workflow === 'inpaint' && !form.maskBase64
            ? 'noMask'
            : request.prompt.length === 0
              ? 'emptyPrompt'
              : null

  const disabledReason: GenerateDisabledReason | null = remote
    ? remoteDisabled
    : generating
      ? 'busy'
      : !engineInstalled
        ? 'noEngine'
        : loadingArtifactId || readingResident
          ? 'modelLoading'
          : targetArtifactId === null
            ? // Nothing to run. A resident model that cannot do this mode is
              // why, when there is one; otherwise none is installed or picked.
              residentCapabilities &&
              !residentCapabilities.workflows.includes(form.workflow)
              ? 'unsupportedWorkflow'
              : 'noModel'
            : residentLacksWorkflow ||
                (capabilities &&
                  !capabilities.workflows.includes(form.workflow))
              ? 'unsupportedWorkflow'
              : spec.needsSource && !form.sourceImage
                ? 'noSource'
                : form.workflow === 'inpaint' && !form.maskBase64
                  ? 'noMask'
                  : form.workflow === 'extend' && !anySide(form.sides)
                    ? 'noSides'
                    : request.prompt.length === 0
                      ? 'emptyPrompt'
                      : null

  const generate = useCallback(async () => {
    if (disabledReason) return
    if (remote) {
      await startGeneration({ request, runs: form.runs, baseSeed })
      return
    }
    if (targetArtifactId === null) return
    if (!modelReady) {
      // Start the picked model first. A failed start leaves its error on
      // the page and nothing is submitted.
      await loadModel(targetArtifactId)
      // What the model turns out not to support is the store's to report.
      const after = useImageGenerationStore.getState()
      if (
        after.status?.model.loaded?.modelId !== targetArtifactId ||
        after.capabilities === null
      )
        return
    }
    let submitted = request
    if (form.workflow === 'extend' && form.sourceImage) {
      const source = form.sourceImage
      const { bytes } = await readFileBytes(source.path, {
        maxBytes: MAX_SOURCE_IMAGE_BYTES,
      })
      const url = URL.createObjectURL(new Blob([bytes]))
      try {
        const image = await loadImage(url)
        const geometry = outpaintGeometry({
          width: image.naturalWidth,
          height: image.naturalHeight,
          expandPercent: form.expandPercent,
          sides: form.sides,
          constraints,
        })
        const canvases = drawOutpaint(image, geometry)
        submitted = {
          ...request,
          width: geometry.width,
          height: geometry.height,
          initImage: { base64: canvases.initBase64 },
          maskImage: { base64: canvases.maskBase64 },
        }
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    await startGeneration({ request: submitted, runs: form.runs, baseSeed })
  }, [
    disabledReason,
    remote,
    targetArtifactId,
    modelReady,
    loadModel,
    startGeneration,
    request,
    form,
    baseSeed,
    constraints,
  ])

  return {
    generating,
    job: currentJob,
    runsTotal,
    runsDone,
    stopRequested,
    modelReady,
    targetArtifactId,
    // A provider's model adopts the form like a family of its own: its defaults, once.
    targetFamilyId: remote
      ? `remote:${remote.target.provider}/${remote.target.model}`
      : target.familyId,
    capabilities,
    canGenerate: disabledReason === null,
    disabledReason,
    request,
    baseSeed,
    outputSize,
    remote,
    generate,
    stop,
  }
}
