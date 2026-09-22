/**
 * The chat side of the GPU arbitration (`lib/diffusion/arbiter.ts`): before a
 * chat model loads, the image model is unloaded when the two would not fit
 * together. The ADR of 2026-09-10 put this call at the chat model-load
 * chokepoint, `DefaultModelsService.startModel`; this is that call, kept apart
 * so it can be tested without the whole service.
 */
import type { AIEngine } from '@janhq/core'

import {
  releaseGpuForChat,
  type ReleaseGpuResult,
} from '@/lib/diffusion/arbiter'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'

/**
 * Bytes the engine says `modelId` weighs, from its model file; `null` when the
 * engine does not know the model or the size. The arbiter treats an unknown
 * size as "does not fit", so `null` becomes an infinite claim there.
 */
export async function chatModelBytes(
  engine: Pick<AIEngine, 'get'>,
  modelId: string
): Promise<number | null> {
  try {
    const info = await engine.get(modelId)
    const bytes = info?.sizeBytes
    return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0
      ? bytes
      : null
  } catch {
    return null
  }
}

/**
 * Makes room on the GPU for `modelId` before the engine loads it. A no-op on
 * platforms without image generation, and never the reason a load fails: an
 * arbiter that cannot answer is logged and the load goes ahead.
 */
export async function makeRoomForChatModel(
  engine: Pick<AIEngine, 'get'>,
  modelId: string
): Promise<ReleaseGpuResult> {
  if (!PlatformFeatures[PlatformFeature.MEDIA_GENERATION]) {
    return { unloadedDiffusion: false }
  }
  const bytes = await chatModelBytes(engine, modelId)
  try {
    return await releaseGpuForChat({
      modelBytes: bytes ?? Number.POSITIVE_INFINITY,
    })
  } catch (error) {
    console.warn(
      `[models] could not make room for ${modelId} on the GPU:`,
      error
    )
    return { unloadedDiffusion: false }
  }
}
