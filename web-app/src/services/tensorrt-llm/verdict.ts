/**
 * The core's verdict on one TensorRT-LLM checkpoint, as the Model Hub shows it (change
 * `add-tensorrt-llm-model-hub`, design D3, D5): the repository read at a revision from Hugging
 * Face, then `POST /models/tensorrt-llm/check`. Nothing about compatibility is decided here.
 *
 * Kept for the session by `repository@revision` — the curated list, a card opened again and the
 * download all ask the same question. Only the core's own answers are kept (`ok`, `incompatible`):
 * a refusal by Hugging Face changes once the person accepts the model's terms, and a network error
 * is not an answer at all.
 */

import type { ModelCompatibility } from '@/services/managed-environment/types'
import {
  checkRequestFor,
  checkTensorrtModel,
  fetchHfRevision,
  GatedModelError,
  IncompatibleModelError,
  InsufficientModelSpaceError,
  type HfRevision,
} from '@/services/tensorrt-llm/models'

export type TensorrtVerdict =
  | { kind: 'ok'; meta: HfRevision; compatibility: ModelCompatibility }
  | { kind: 'incompatible'; compatibility: ModelCompatibility }
  | { kind: 'gated'; url: string }
  /** The core has less room where models go than the download needs (on Windows: the guest). */
  | { kind: 'no-space'; root: string; neededBytes: number; freeBytes: number }
  | { kind: 'error'; message: string }

export const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

async function evaluate(
  repository: string,
  revision: string | undefined,
  token: string | undefined
): Promise<TensorrtVerdict> {
  try {
    const meta = await fetchHfRevision(repository, revision, token)
    const compatibility = await checkTensorrtModel(checkRequestFor(meta))
    return compatibility.verdict.ok
      ? { kind: 'ok', meta, compatibility }
      : { kind: 'incompatible', compatibility }
  } catch (error) {
    if (error instanceof GatedModelError) return { kind: 'gated', url: error.url }
    return { kind: 'error', message: errorText(error) }
  }
}

const pending = new Map<string, Promise<TensorrtVerdict>>()
const settled = new Map<string, TensorrtVerdict>()

const keyOf = (repository: string, revision: string | undefined) =>
  `${repository}@${revision ?? 'main'}`

export function resetTensorrtVerdictsForTests(): void {
  pending.clear()
  settled.clear()
}

/** The verdict already held for this repository and revision, without asking. */
export function heldTensorrtVerdict(
  repository: string,
  revision: string | undefined
): TensorrtVerdict | undefined {
  return settled.get(keyOf(repository, revision))
}

/** The core's verdict, asked once per repository and revision while its answer stands. */
export function tensorrtVerdict(
  repository: string,
  revision: string | undefined,
  token: string | undefined
): Promise<TensorrtVerdict> {
  const key = keyOf(repository, revision)
  const held = settled.get(key)
  if (held) return Promise.resolve(held)
  const asking = pending.get(key)
  if (asking) return asking
  const promise = evaluate(repository, revision, token).then((verdict) => {
    pending.delete(key)
    if (verdict.kind === 'ok' || verdict.kind === 'incompatible') settled.set(key, verdict)
    return verdict
  })
  pending.set(key, promise)
  return promise
}

/**
 * The core refused the model for every card of this machine. Anything else — it runs here or on
 * another card, or the core was never asked (Hugging Face refused access or could not be reached)
 * — keeps a curated model listed, and its card says which.
 */
export function refusedOnEveryCard(verdict: TensorrtVerdict): boolean {
  return verdict.kind === 'incompatible' && verdict.compatibility.fits_other_gpus.length === 0
}

/**
 * Why a download did not happen, in the same terms as the card's verdict: the core refused the
 * files when it checked them again, Hugging Face refused access, the core has no room, or else.
 */
export function verdictFromError(error: unknown): TensorrtVerdict {
  if (error instanceof IncompatibleModelError) {
    return { kind: 'incompatible', compatibility: error.compatibility }
  }
  if (error instanceof GatedModelError) return { kind: 'gated', url: error.url }
  if (error instanceof InsufficientModelSpaceError) {
    return {
      kind: 'no-space',
      root: error.root,
      neededBytes: error.neededBytes,
      freeBytes: error.freeBytes,
    }
  }
  return { kind: 'error', message: errorText(error) }
}
