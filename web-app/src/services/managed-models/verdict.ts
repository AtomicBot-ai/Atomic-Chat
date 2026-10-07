/**
 * A managed engine's verdict on one checkpoint, as the Model Hub shows it (change
 * `add-tensorrt-llm-model-hub`, design D3, D5; per engine, change `add-vllm-runtime`, design D14):
 * the repository read at a revision from Hugging Face, then `POST /models/<engine>/check`. Nothing
 * about compatibility is decided here.
 *
 * Kept for the session by engine, the engine's descriptor, the engine's settings and
 * `repository@revision` (design D14) — the curated list, a card opened again and the download all
 * ask the same question, and an engine installed or updated to another descriptor asks again. The
 * settings are part of it because the core judges memory with them: fewer parallel requests or a
 * shorter context can make a refused model fit. Only the core's own answers are kept (`ok`, `incompatible`):
 * a refusal by Hugging Face changes once the person accepts the model's terms, and a network error
 * is not an answer at all.
 */

import type { ModelCompatibility } from '@/services/managed-environment/types'
import {
  checkManagedModel,
  checkRequestFor,
  fetchHfRevision,
  GatedModelError,
  IncompatibleModelError,
  InsufficientModelSpaceError,
  type HfRevision,
} from '@/services/managed-models/models'

export type ManagedVerdict =
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
  engineId: string,
  repository: string,
  revision: string | undefined,
  token: string | undefined
): Promise<ManagedVerdict> {
  try {
    const meta = await fetchHfRevision(repository, revision, token)
    const compatibility = await checkManagedModel(engineId, checkRequestFor(meta))
    return compatibility.verdict.ok
      ? { kind: 'ok', meta, compatibility }
      : { kind: 'incompatible', compatibility }
  } catch (error) {
    if (error instanceof GatedModelError) return { kind: 'gated', url: error.url }
    return { kind: 'error', message: errorText(error) }
  }
}

const pending = new Map<string, Promise<ManagedVerdict>>()
const settled = new Map<string, ManagedVerdict>()

const keyOf = (
  engineId: string,
  descriptorId: string | null,
  settingsKey: string,
  repository: string,
  revision: string | undefined
) => `${engineId}|${descriptorId ?? ''}|${settingsKey}|${repository}@${revision ?? 'main'}`

/** The engine's settings as the person set them, as one string: key order does not matter. */
export function engineSettingsKey(settings: ProviderSetting[] | undefined): string {
  return JSON.stringify(
    (settings ?? [])
      .map((setting) => [setting.key, setting.controller_props?.value ?? null] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

export function resetManagedVerdictsForTests(): void {
  pending.clear()
  settled.clear()
}

/**
 * The verdict of `engineId` with the descriptor `descriptorId` already held for this repository and
 * revision, without asking.
 */
export function heldManagedVerdict(
  engineId: string,
  descriptorId: string | null,
  settingsKey: string,
  repository: string,
  revision: string | undefined
): ManagedVerdict | undefined {
  return settled.get(keyOf(engineId, descriptorId, settingsKey, repository, revision))
}

/**
 * The engine's verdict, asked once per engine, descriptor, settings, repository and revision while
 * its answer stands. `descriptorId` is the descriptor the engine checks with — its installation's,
 * else the one its plan would install; the core picks it itself, so it only keys the answer, as
 * `settingsKey` ({@link engineSettingsKey}) does: the check hands the settings over itself.
 */
export function managedVerdict(
  engineId: string,
  descriptorId: string | null,
  settingsKey: string,
  repository: string,
  revision: string | undefined,
  token: string | undefined
): Promise<ManagedVerdict> {
  const key = keyOf(engineId, descriptorId, settingsKey, repository, revision)
  const held = settled.get(key)
  if (held) return Promise.resolve(held)
  const asking = pending.get(key)
  if (asking) return asking
  const promise = evaluate(engineId, repository, revision, token).then((verdict) => {
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
export function refusedOnEveryCard(verdict: ManagedVerdict): boolean {
  return verdict.kind === 'incompatible' && verdict.compatibility.fits_other_gpus.length === 0
}

/**
 * Why a download did not happen, in the same terms as the card's verdict: the core refused the
 * files when it checked them again, Hugging Face refused access, the core has no room, or else.
 */
export function verdictFromError(error: unknown): ManagedVerdict {
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
