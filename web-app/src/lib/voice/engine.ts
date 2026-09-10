/**
 * Bridge to the llama.cpp engine that runs the voice model.
 *
 * Transcription is deliberately pinned to `llamacpp-upstream`: it is the
 * default provider on every platform, and its bundled `libmtmd` is the one that
 * carries the `voxtral` audio projector. The TurboQuant fork lags upstream and
 * is disabled on fresh installs, so it is not a supported target here.
 */

import { AIEngine, EngineManager, SessionInfo } from '@janhq/core'

import { VOICE_MODEL_ID, VOICE_PROVIDER } from '@/constants/voice'

/** The extra surface the upstream extension exposes for dictation. */
type VoiceEngine = AIEngine & {
  ensureTranscriptionModel?: (bypassAutoUnload?: boolean) => Promise<SessionInfo>
  touchTranscriptionIdleTimer?: () => void
  releaseTranscriptionModel?: () => Promise<void>
}

export type VoiceEngineTarget = {
  baseUrl: string
  apiKey: string
  model: string
}

/** Error codes the extension raises, mirrored so callers can branch on them. */
export const VOICE_ENGINE_ERRORS = {
  modelMissing: 'TRANSCRIPTION_MODEL_MISSING',
  unsupported: 'TRANSCRIPTION_UNSUPPORTED',
} as const

function engine(): VoiceEngine | undefined {
  return EngineManager.instance().get(VOICE_PROVIDER) as VoiceEngine | undefined
}

export function errorCodeOf(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code
}

/** Is the voice model on disk? */
export async function isVoiceModelInstalled(): Promise<boolean> {
  try {
    const models = (await engine()?.list()) ?? []
    return models.some((model) => model.id === VOICE_MODEL_ID)
  } catch {
    return false
  }
}

/**
 * Start (or reuse) the voice server and return where to send audio.
 *
 * The extension loads it with `bypassAutoUnload`, so this runs as a second
 * llama-server alongside the user's chat model rather than replacing it.
 */
export async function ensureVoiceEngine(
  options: { keepChatModelLoaded?: boolean } = {}
): Promise<VoiceEngineTarget> {
  const target = engine()
  if (!target?.ensureTranscriptionModel) {
    const error = new Error(
      'The local llama.cpp engine is not available.'
    ) as Error & { code?: string }
    error.code = VOICE_ENGINE_ERRORS.unsupported
    throw error
  }

  const session = await target.ensureTranscriptionModel(
    options.keepChatModelLoaded ?? true
  )
  return {
    baseUrl: `http://127.0.0.1:${session.port}/v1`,
    apiKey: session.api_key,
    model: session.model_id,
  }
}

/** Keep the voice model from being unloaded while dictation is in use. */
export function keepVoiceEngineWarm(): void {
  engine()?.touchTranscriptionIdleTimer?.()
}

/** Unload the voice model now — used when the user removes it. */
export async function releaseVoiceEngine(): Promise<void> {
  await engine()?.releaseTranscriptionModel?.()
}
