/**
 * The Cloud page's cross-provider model index: one entry per model, with every
 * hosted provider that serves it — what "Available through N providers" reads.
 *
 * Providers name the same model differently (OpenRouter `openai/gpt-5.4`,
 * OpenAI `gpt-5.4`) and the provider registry carries no canonical id yet, so
 * the match is a heuristic on the id: the vendor prefix dropped, lower-cased.
 * A canonical id in the registry is the follow-up that makes this exact.
 */

import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { getModelDisplayName, getProviderTitle } from '@/lib/utils'

export type CloudModelEntry = {
  /** The normalised id the providers are matched on. */
  key: string
  /** The name the first provider listing it gives it. */
  name: string
  /** Provider ids that serve it, in the order the providers came in. */
  providers: string[]
}

/** `openai/GPT-5.4` and `gpt-5.4` are the same model here. */
export function normalizeCloudModelId(id: string): string {
  const slash = id.lastIndexOf('/')
  return (slash === -1 ? id : id.slice(slash + 1)).trim().toLowerCase()
}

/** The models a provider lists, without the local embedding stand-in. */
export function listedModels(provider: ProviderObject): Model[] {
  return (provider.models ?? []).filter((m) => m.id !== EMBEDDING_MODEL_ID)
}

export function buildCloudModelCatalog(
  providers: ProviderObject[]
): CloudModelEntry[] {
  const byKey = new Map<string, CloudModelEntry>()
  for (const provider of providers) {
    for (const model of listedModels(provider)) {
      const key = normalizeCloudModelId(model.id)
      if (!key) continue
      const entry = byKey.get(key)
      if (!entry) {
        byKey.set(key, {
          key,
          name: getModelDisplayName(model),
          providers: [provider.provider],
        })
      } else if (!entry.providers.includes(provider.provider)) {
        entry.providers.push(provider.provider)
      }
    }
  }
  return [...byKey.values()]
}

/** Entries whose name or id contains `query` (already trimmed). */
export function searchCloudModels(
  catalog: CloudModelEntry[],
  query: string
): CloudModelEntry[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  return catalog.filter((entry) =>
    `${entry.name} ${entry.key}`.toLowerCase().includes(needle)
  )
}

/** Providers whose title or id contains `query` (already trimmed). */
export function searchCloudProviders(
  providers: ProviderObject[],
  query: string
): ProviderObject[] {
  const needle = query.toLowerCase()
  if (!needle) return providers
  return providers.filter((provider) =>
    `${getProviderTitle(provider.provider)} ${provider.provider}`
      .toLowerCase()
      .includes(needle)
  )
}
