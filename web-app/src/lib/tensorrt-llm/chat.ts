/**
 * What chatting with a TensorRT-LLM model does differently (spec `tensorrt-llm-desktop`, "Чат с учётом
 * возможностей модели", "Загрузка модели не выглядит как зависание"; design D8, D9).
 *
 * - The engine calls tools only for a model family the installed descriptor gives a tool parser, and
 *   the core reports that as the model's `tools` capability. Without it the core's gateway refuses
 *   `tools` outright, so Agent mode is off for that model, with a reason.
 * - The context length is fixed when the container starts; the core never restarts a multi-minute
 *   load to grow it. So an overflow is an error with the limit, not an automatic reload.
 * - A load takes minutes and reports its stages; the load snackbar names the stage and the time.
 */

import type { CoreSessionLoadStage } from '@/lib/tensorrt-llm/types'

export const TENSORRT_LLM = 'tensorrt-llm'

export type AgentModelBlockReason = 'model-without-tools'

/** Why this model cannot serve an Agent turn, or `null` when its provider's rules apply. */
export function agentModelBlockReason(
  providerName: string | undefined,
  model: Model | undefined
): AgentModelBlockReason | null {
  if (providerName !== TENSORRT_LLM || !model) return null
  return model.capabilities?.includes('tools') ? null : 'model-without-tools'
}

/**
 * Whether images may be attached for this model: its `vision` capability, except that no
 * TensorRT-LLM model takes images in this release, whatever its capabilities were edited to say.
 */
export function imageAttachmentsAllowed(providerName: string | undefined, model: Model | undefined): boolean {
  if (providerName === TENSORRT_LLM) return false
  return model?.capabilities?.includes('vision') ?? false
}

/**
 * The core's schema lets a TensorRT-LLM load take up to an hour (`load_timeout_seconds` ≤ 3600),
 * plus the time to stop the previous model; the app's safety net must outlast it, or the switch
 * reports a failure while the container is still starting.
 */
const TENSORRT_LLM_LOAD_WATCHDOG_MS = 65 * 60_000

/** How long the app waits on one model load before giving up on it. */
export function loadWatchdogMs(providerName: string | undefined, defaultMs: number): number {
  return providerName === TENSORRT_LLM ? Math.max(defaultMs, TENSORRT_LLM_LOAD_WATCHDOG_MS) : defaultMs
}

/** Whether the app may reload this provider's model with a larger context. */
export function canGrowContext(providerName: string | undefined): boolean {
  return providerName !== TENSORRT_LLM
}

/**
 * The limit a TensorRT-LLM overflow reported (OpenAI `context_length_exceeded`, which the core's
 * gateway maps `trtllm-serve`'s message to), and the engine's own sentence with both numbers.
 */
export function contextOverflowGuidance(
  providerName: string | undefined,
  error: unknown
): { limit: number | null; detail: string } | null {
  if (providerName !== TENSORRT_LLM || !error) return null
  const detail = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error)
  const lower = detail.toLowerCase()
  if (!lower.includes('context_length_exceeded') && !lower.includes('maximum context length')) return null
  const limit = /maximum context length is (\d+)/i.exec(detail)
  return { limit: limit ? Number(limit[1]) : null, detail: detail.replace(/\s*\[context_length_exceeded\]\s*$/i, '') }
}

/**
 * What the chat says about a TensorRT-LLM overflow: the engine's own numbers, and where to raise
 * the limit. English like the rest of the chat error copy (`utils/error.ts`).
 */
export function contextOverflowMessage(guidance: { limit: number | null; detail: string }): string {
  const limit = guidance.limit !== null ? `${guidance.limit} tokens` : 'its context length'
  return `This conversation no longer fits in the model's context of ${limit}: ${guidance.detail} TensorRT-LLM does not grow the context by itself. Increase Context Length in Settings → Providers → TensorRT-LLM (the model will restart with the new length), or start a new chat.`
}

/** The snackbar's words for a load stage: which translation, and the time spent as m:ss. */
export function engineStageText(progress: { stage: CoreSessionLoadStage; elapsedMs: number }): {
  key: string
  elapsed: string
} {
  const seconds = Math.max(0, Math.floor(progress.elapsedMs / 1000))
  return {
    key: `common:modelLoad.engine.${progress.stage}`,
    elapsed: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
  }
}
