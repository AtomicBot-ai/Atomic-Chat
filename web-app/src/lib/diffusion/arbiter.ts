/**
 * GPU arbitration between chat and diffusion.
 *
 * A machine holds one big thing at a time. Before a diffusion model loads,
 * every chat session that would not fit beside it is unloaded — across all
 * `EngineManager` engines (llamacpp, llamacpp-upstream, mlx). Embedding
 * sessions stay: they are small and the RAG pipeline expects them. The voice
 * model stays unless it is *still* in the way after the chat models are gone.
 *
 * The reverse direction — a chat model loading while a diffusion session is
 * resident — is {@link releaseGpuForChat}. Its call site is the chat-model
 * chokepoint, `services/models/default.ts::startModel`, just before
 * `engine.load(...)`, guarded by `PlatformFeature.MEDIA_GENERATION`; it is not
 * wired from here so this module stays free of the models service. Tell it
 * the incoming model's byte count (`modelInfo.sizeBytes`) and it unloads the
 * diffusion session only when the two would not coexist.
 *
 * Every call is serialised through one module-level promise: two loads
 * racing each other would otherwise evict each other's sessions.
 */

import { EngineManager, type AIEngine } from '@janhq/core'

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { VOICE_MODEL_BYTES, VOICE_MODEL_ID } from '@/constants/voice'
import { useHardware } from '@/hooks/useHardware'
import { getServiceHub, isServiceHubInitialized } from '@/hooks/useServiceHub'
import {
  describeHardware,
  MACOS_LOAD_CEILING,
  type HardwareProfile,
} from '@/lib/hardware-tier'

const MIB = 1024 * 1024

/**
 * Share of the pool two workloads may fill together on a PC. Overshooting
 * spills to system RAM rather than failing, but a swap-bound GPU is no use
 * to either side.
 */
export const COEXIST_SHARE = 0.9

export type AcquireGpuOptions = {
  /** Bytes the diffusion session will hold resident (see `lib/diffusion/fit.ts`). */
  requiredBytes: number
  /** `always` evicts every chat session; `whenNeeded` only what would not fit. */
  policy: 'whenNeeded' | 'always'
  /** Keep the voice model even when it is in the way. */
  keepVoiceModel?: boolean
}

export type AcquireGpuResult = { evicted: string[] }

export type ReleaseGpuOptions = {
  /** Bytes of the chat model about to load. */
  modelBytes: number
}

export type ReleaseGpuResult = { unloadedDiffusion: boolean }

type LoadedSession = {
  engine: AIEngine
  modelId: string
  sizeBytes: number | null
  embedding: boolean
}

let queue: Promise<unknown> = Promise.resolve()

/** Run `task` after every previously scheduled arbitration has settled. */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

/** Bytes the diffusion session most recently acquired; null when none is known. */
let diffusionResidentBytes: number | null = null

function currentProfile(): HardwareProfile | null {
  try {
    return describeHardware(useHardware.getState().hardwareData)
  } catch {
    return null
  }
}

/** The bytes two workloads may share; null when the hardware is unknown. */
function coexistBudgetBytes(profile: HardwareProfile | null): number | null {
  if (!profile || profile.budgetMib <= 0) return null
  const share = profile.hardCeiling ? MACOS_LOAD_CEILING : COEXIST_SHARE
  return profile.budgetMib * MIB * share
}

/**
 * Whether `bytes` fits in the budget. Unknown hardware or an unknown size is
 * treated as "does not fit": evicting a session the machine could have held
 * costs a reload; keeping one it cannot hold costs an OOM mid-generation.
 */
export function wouldCoexist(
  bytes: number | null,
  profile: HardwareProfile | null
): boolean {
  const budget = coexistBudgetBytes(profile)
  if (budget === null || bytes === null) return false
  return bytes <= budget
}

async function loadedSessions(): Promise<LoadedSession[]> {
  const sessions: LoadedSession[] = []
  for (const engine of EngineManager.instance().engines.values()) {
    let ids: string[]
    try {
      ids = await engine.getLoadedModels()
    } catch {
      continue
    }
    for (const modelId of ids) {
      let sizeBytes: number | null = null
      let embedding = modelId === EMBEDDING_MODEL_ID
      try {
        const info = await engine.get(modelId)
        if (info) {
          if (Number.isFinite(info.sizeBytes) && info.sizeBytes > 0) {
            sizeBytes = info.sizeBytes
          }
          embedding = embedding || info.embedding === true
        }
      } catch {
        // Size unknown; treated as not fitting below.
      }
      sessions.push({ engine, modelId, sizeBytes, embedding })
    }
  }
  return sessions
}

async function unloadAll(sessions: LoadedSession[]): Promise<string[]> {
  const evicted: string[] = []
  await Promise.all(
    sessions.map(async (session) => {
      try {
        await session.engine.unload(session.modelId)
        evicted.push(session.modelId)
      } catch (error) {
        console.warn(
          `[diffusion-arbiter] could not unload ${session.modelId}:`,
          error
        )
      }
    })
  )
  return evicted
}

/**
 * Make room for a diffusion session. Resolves once every evicted session's
 * `unload` has returned; the plugin itself waits for the driver to settle.
 */
export function acquireGpuForDiffusion(
  opts: AcquireGpuOptions
): Promise<AcquireGpuResult> {
  return serialize(async () => {
    const profile = currentProfile()
    const sessions = await loadedSessions()
    const chat = sessions.filter(
      (s) => !s.embedding && s.modelId !== VOICE_MODEL_ID
    )
    const voice = sessions.find((s) => s.modelId === VOICE_MODEL_ID)

    const chatBytes = chat.reduce<number | null>(
      (sum, s) => (sum === null || s.sizeBytes === null ? null : sum + s.sizeBytes),
      0
    )
    const voiceBytes = voice ? (voice.sizeBytes ?? VOICE_MODEL_BYTES) : 0

    let toEvict: LoadedSession[] = []
    if (opts.policy === 'always') {
      toEvict = chat
    } else if (
      chat.length > 0 &&
      !wouldCoexist(
        chatBytes === null ? null : chatBytes + voiceBytes + opts.requiredBytes,
        profile
      )
    ) {
      toEvict = chat
    }

    if (
      voice &&
      !opts.keepVoiceModel &&
      !wouldCoexist(voiceBytes + opts.requiredBytes, profile)
    ) {
      toEvict = [...toEvict, voice]
    }

    const evicted = await unloadAll(toEvict)
    diffusionResidentBytes = opts.requiredBytes
    return { evicted }
  })
}

/**
 * Make room for a chat model. Unloads the diffusion session when one is
 * resident and the two would not coexist. Safe to call when the service is
 * unavailable: it simply reports nothing unloaded.
 */
export function releaseGpuForChat(
  opts: ReleaseGpuOptions
): Promise<ReleaseGpuResult> {
  return serialize(async () => {
    if (!isServiceHubInitialized()) return { unloadedDiffusion: false }
    const diffusion = getServiceHub().diffusion()
    if (!diffusion.isSupported()) return { unloadedDiffusion: false }

    let resident = false
    try {
      const status = await diffusion.getStatus()
      resident =
        status.configured &&
        (status.model.state === 'loaded' || status.model.state === 'loading')
    } catch {
      return { unloadedDiffusion: false }
    }
    if (!resident) return { unloadedDiffusion: false }

    const combined =
      diffusionResidentBytes === null
        ? null
        : diffusionResidentBytes + opts.modelBytes
    if (wouldCoexist(combined, currentProfile())) {
      return { unloadedDiffusion: false }
    }

    await diffusion.unloadModel()
    diffusionResidentBytes = null
    return { unloadedDiffusion: true }
  })
}

/** Forget the resident diffusion size, e.g. after the plugin reports an unload. */
export function noteDiffusionUnloaded(): void {
  diffusionResidentBytes = null
}
