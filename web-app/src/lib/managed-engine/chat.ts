/**
 * What chatting with a managed engine's model (TensorRT-LLM, vLLM) does differently (spec
 * `tensorrt-llm-desktop`, "Чат с учётом возможностей модели", "Загрузка модели не выглядит как
 * зависание"; spec `vllm-desktop`, "Чат с моделью vLLM"; design D8, D9). Decided by the provider
 * being a managed engine and by the model's capabilities, never by an engine's id (change
 * `add-vllm-runtime`, design D14).
 *
 * - The engine calls tools only for a model family the installed descriptor gives a tool parser, and
 *   the core reports that as the model's `tools` capability. Without it the core's gateway refuses
 *   `tools` outright, so Agent mode is off for that model, with a reason.
 * - The context length is fixed when the container starts; the core never restarts a multi-minute
 *   load to grow it. So an overflow is an error with the limit, not an automatic reload.
 * - A load takes minutes and reports its stages; the load snackbar names the stage and the time.
 */

import type { CoreSessionLoadStage } from '@/lib/managed-engine/types'
import { isManagedProvider, managedEngine, type ManagedEngine } from '@/lib/managed-engines'

export type AgentModelBlockReason = 'model-without-tools'

/** Why this model cannot serve an Agent turn, or `null` when its provider's rules apply. */
export function agentModelBlockReason(
  providerName: string | undefined,
  model: Model | undefined
): AgentModelBlockReason | null {
  if (!isManagedProvider(providerName) || !model) return null
  return model.capabilities?.includes('tools') ? null : 'model-without-tools'
}

/**
 * Whether images may be attached for this model: its `vision` capability, except that no managed
 * engine's model takes images in this release, whatever its capabilities were edited to say.
 */
export function imageAttachmentsAllowed(providerName: string | undefined, model: Model | undefined): boolean {
  if (isManagedProvider(providerName)) return false
  return model?.capabilities?.includes('vision') ?? false
}

/**
 * The core's schemas let a managed engine's load take up to an hour (`load_timeout_seconds` ≤ 3600
 * for TensorRT-LLM and vLLM), plus the time to stop the previous model; the app's safety net must
 * outlast it, or the switch reports a failure while the container is still starting.
 */
const MANAGED_LOAD_WATCHDOG_MS = 65 * 60_000

/** How long the app waits on one model load before giving up on it. */
export function loadWatchdogMs(providerName: string | undefined, defaultMs: number): number {
  return isManagedProvider(providerName) ? Math.max(defaultMs, MANAGED_LOAD_WATCHDOG_MS) : defaultMs
}

/** Whether the app may reload this provider's model with a larger context. */
export function canGrowContext(providerName: string | undefined): boolean {
  return !isManagedProvider(providerName)
}

export interface ContextOverflowGuidance {
  /** The engine whose settings raise the limit. */
  engine: ManagedEngine
  limit: number | null
  detail: string
}

/**
 * The limit a managed engine's overflow reported (OpenAI `context_length_exceeded`, which the
 * core's gateway maps the engine's message to), and the engine's own sentence with both numbers.
 */
export function contextOverflowGuidance(
  providerName: string | undefined,
  error: unknown
): ContextOverflowGuidance | null {
  const engine = managedEngine(providerName)
  if (!engine || !error) return null
  const detail = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error)
  const lower = detail.toLowerCase()
  if (!lower.includes('context_length_exceeded') && !lower.includes('maximum context length')) return null
  const limit = /maximum context length is (\d+)/i.exec(detail)
  return {
    engine,
    limit: limit ? Number(limit[1]) : null,
    detail: detail.replace(/\s*\[context_length_exceeded\]\s*$/i, ''),
  }
}

/**
 * What the chat says about a managed engine's overflow: the engine's own numbers, and where to
 * raise the limit. English like the rest of the chat error copy (`utils/error.ts`).
 */
export function contextOverflowMessage(guidance: ContextOverflowGuidance): string {
  const limit = guidance.limit !== null ? `${guidance.limit} tokens` : 'its context length'
  const name = guidance.engine.label
  return `This conversation no longer fits in the model's context of ${limit}: ${guidance.detail} ${name} does not grow the context by itself. Increase Context Length in Settings → Providers → ${name} (the model will restart with the new length), or start a new chat.`
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
