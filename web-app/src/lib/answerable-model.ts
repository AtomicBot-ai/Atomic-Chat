/**
 * "Is this model something the user could actually send a message with?"
 *
 * One predicate, shared by the onboarding gate and the composer's
 * reply-model widget, so the two cannot disagree about what "having a model"
 * means. They used to: the gate counted every entry in `provider.models`,
 * while the widget skipped broken links and the embedding model — so an
 * install could pass the gate, skip onboarding, and still have nothing to
 * answer with on its first send (ATO-452).
 */

import { EMBEDDING_MODEL_ID } from '@/constants/models'

/** The two fields the decision needs; `Model` from the provider store fits. */
export type AnswerableModelLike = {
  id?: string
  /** Runtime-computed: the weights file is gone — a "broken link". */
  missing?: boolean
}

/**
 * A local model that could be loaded and chatted with right now.
 *
 * Excluded: a broken link (loading it only crashes the engine) and the
 * bundled embedding model (not something to chat with).
 */
export function isAnswerableModel(model: AnswerableModelLike): boolean {
  if (!model.id) return false
  if (model.id === EMBEDDING_MODEL_ID) return false
  if (model.missing) return false
  return true
}
