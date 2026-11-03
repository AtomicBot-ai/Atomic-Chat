/**
 * Model ids a custom endpoint shares with a local engine (AC-03).
 *
 * The Local API Server routes by model id. For an id both a local engine and
 * an endpoint list, the server sends requests to the provider selected for it
 * on the server page, and with no selection to the endpoint (a remote
 * provider that lists an id wins). The endpoint dialog says which, so nobody
 * finds out from a request that went somewhere unexpected.
 */

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { isLocalProvider } from '@/utils/registerRemoteProvider'
import type { ServedModelSelection } from '@/utils/serverModelSelection'

export type LocalModelCollision = {
  model: string
  /**
   * The provider the server sends the id to: the one selected for it on the
   * server page, or `undefined` when none is and the endpoint gets it.
   */
  served?: string
}

type ProviderLike = { provider: string; models?: Array<{ id: string }> }

export function localModelCollisions(
  endpointModelIds: string[],
  providers: ProviderLike[],
  selection: ServedModelSelection[]
): LocalModelCollision[] {
  const local = new Set(
    providers
      .filter((p) => isLocalProvider(p.provider))
      .flatMap((p) => (p.models ?? []).map((m) => m.id))
  )
  local.delete(EMBEDDING_MODEL_ID)
  const seen = new Set<string>()
  const collisions: LocalModelCollision[] = []
  for (const model of endpointModelIds) {
    if (!local.has(model) || seen.has(model)) continue
    seen.add(model)
    const served = selection.find((s) => s.model === model)?.provider
    collisions.push(served ? { model, served } : { model })
  }
  return collisions
}
