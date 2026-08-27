/**
 * Best-effort pre-warm of the embedding model before an agent turn that
 * carries RAG context. The Rust `docs.*` tools only *find* a running
 * embedding session — they never start one — so the frontend spins it up the
 * same way the chat pipeline's ingestion does: one throwaway `embed` call
 * through the llamacpp extension, which downloads/starts
 * `sentence-transformer-mini` on demand.
 *
 * Never throws. Success is memoized for the app session; a failure resets the
 * memo so the next send retries. If the warm-up loses anyway (timeout, no
 * extension), the turn still runs — `docs.retrieve` then reports a structured
 * "embedding model is not running" error the model can relay.
 */

const EMBEDDING_WARMUP_TIMEOUT_MS = 60_000

type EmbeddingEngine = {
  embed?: (texts: string[]) => Promise<unknown>
}

// Same resolution order as the RAG extension's `embedTexts`: upstream engine
// first, legacy turboquant fork as fallback.
const EMBEDDING_ENGINE_NAMES = [
  '@janhq/llamacpp-upstream-extension',
  '@janhq/llamacpp-extension',
]

let warmupPromise: Promise<void> | null = null

const warmup = async (): Promise<void> => {
  const engine = EMBEDDING_ENGINE_NAMES.map(
    (name) =>
      window.core?.extensionManager?.getByName(name) as
        | EmbeddingEngine
        | undefined
  ).find((candidate) => candidate?.embed)
  if (!engine?.embed) {
    throw new Error('no llamacpp extension with embedding support is available')
  }
  await Promise.race([
    engine.embed(['warmup']),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('embedding warm-up timed out')),
        EMBEDDING_WARMUP_TIMEOUT_MS
      )
    ),
  ])
}

export const ensureEmbeddingsReady = (): Promise<void> => {
  if (!warmupPromise) {
    warmupPromise = warmup().catch((error) => {
      warmupPromise = null
      console.warn(
        '[Agent] Embedding warm-up failed; document search may be unavailable this turn:',
        error
      )
    })
  }
  return warmupPromise
}

export const resetEmbeddingsWarmupForTest = (): void => {
  warmupPromise = null
}
