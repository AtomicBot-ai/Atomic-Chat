/**
 * Which model starts are under way, and which models chat requests are using.
 *
 * Chat requests and model switches run side by side, and on the first turn
 * after a load they used to trip over each other:
 *
 * - A send made while its model was still starting called `startModel` itself,
 *   next to the switch's own load of the same model, so the engine was asked
 *   for two loads of one model at once.
 * - A switch stopped engines, and restarted the Local API Server, under a
 *   request that had just been sent or was still being answered.
 *
 * Both ended the turn without a reply. So a start is shared per provider and
 * model (whoever comes second waits for the first), and a request holds the
 * model it uses until its response has been read; a switch waits for those
 * holds before it stops anything they depend on.
 *
 * Deliberately free of imports: the chat transport's model factory and the
 * model switch both depend on it, and neither may pull the other in.
 */

export type ModelRef = { provider: string; modelId: string }

const modelKey = (provider: string, modelId: string) =>
  `${provider}::${modelId}`

// ── Shared starts ──────────────────────────────────────────────────────────

const starts = new Map<string, Promise<void>>()

/** The start of this model that is under way, if any. */
export function pendingModelStart(
  provider: string,
  modelId: string
): Promise<void> | undefined {
  return starts.get(modelKey(provider, modelId))
}

/**
 * Make `start` the start of this model that later callers join through
 * {@link pendingModelStart}, until it settles. The returned promise settles
 * with it.
 */
export function shareModelStart(
  provider: string,
  modelId: string,
  start: Promise<unknown>
): Promise<void> {
  const key = modelKey(provider, modelId)
  const shared = start.then(() => undefined)
  starts.set(key, shared)
  const clear = () => {
    if (starts.get(key) === shared) starts.delete(key)
  }
  // Also marks the rejection handled: nobody may be waiting on it.
  shared.then(clear, clear)
  return shared
}

// ── Holds ──────────────────────────────────────────────────────────────────

type Hold = { ref: ModelRef; lastActive: number; idleMs: number }

/** One per request in flight. */
const holds = new Set<Hold>()
/** One per model: a model object that has not sent its first request yet. */
const pendingHolds = new Map<string, Hold>()
let wakeUps: Array<() => void> = []

function wake(): void {
  const waiting = wakeUps
  wakeUps = []
  for (const resolve of waiting) resolve()
}

export type ModelHold = {
  /** The request is still making progress: restart its idle clock. */
  touch: () => void
  /** Done with the model. Safe to call more than once. */
  release: () => void
}

/**
 * Hold `provider/modelId` for one request. A hold that sees no `touch` for
 * `idleMs` lapses on its own, so a response nobody reads to the end cannot
 * keep a model switch waiting forever.
 */
export function holdModel(
  provider: string,
  modelId: string,
  idleMs: number
): ModelHold {
  const hold: Hold = {
    ref: { provider, modelId },
    lastActive: Date.now(),
    idleMs,
  }
  holds.add(hold)
  return {
    touch: () => {
      hold.lastActive = Date.now()
    },
    release: () => {
      if (holds.delete(hold)) wake()
    },
  }
}

/**
 * Hold `provider/modelId` from the moment a model object for it exists until
 * that object sends its first request (which takes a hold of its own), or
 * `maxMs` passes. One per model: a newer model object replaces the older's,
 * which covered the same model.
 */
export function holdModelUntilFirstRequest(
  provider: string,
  modelId: string,
  maxMs: number
): () => void {
  const key = modelKey(provider, modelId)
  const hold: Hold = {
    ref: { provider, modelId },
    lastActive: Date.now(),
    idleMs: maxMs,
  }
  pendingHolds.set(key, hold)
  return () => {
    if (pendingHolds.get(key) !== hold) return
    pendingHolds.delete(key)
    wake()
  }
}

/** Every model a request is waiting on or reading from now. */
export function heldModels(): ModelRef[] {
  const now = Date.now()
  const refs: ModelRef[] = []
  for (const hold of holds) {
    if (now - hold.lastActive < hold.idleMs) refs.push(hold.ref)
    else holds.delete(hold)
  }
  for (const [key, hold] of pendingHolds) {
    if (now - hold.lastActive < hold.idleMs) refs.push(hold.ref)
    else pendingHolds.delete(key)
  }
  return refs
}

/** How often a wait re-reads the holds, for lapses and for `stop`. */
const HOLD_POLL_MS = 250

/**
 * Resolve once no hold `matches`, or `stop()` turns true. Returns whether it
 * had to wait at all.
 */
export async function waitForModelHolds(
  matches: (ref: ModelRef) => boolean,
  stop: () => boolean = () => false
): Promise<boolean> {
  let waited = false
  while (!stop() && heldModels().some(matches)) {
    waited = true
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        wakeUps = wakeUps.filter((wakeUp) => wakeUp !== done)
        resolve()
      }
      const timer = setTimeout(done, HOLD_POLL_MS)
      wakeUps.push(done)
    })
  }
  return waited
}

/** Test seam: forget every start and hold. */
export function resetModelLifecycleForTests(): void {
  starts.clear()
  holds.clear()
  pendingHolds.clear()
  wake()
}
