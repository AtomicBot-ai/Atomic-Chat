import { atomicModelCatalogSnapshot } from '@janhq/core'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isAnswerableModel } from '@/lib/answerable-model'
import { drafters } from '@/services/drafters'

const upstream = 'llamacpp-upstream'

/** Match installed models using the same checkpoint verdict as the composer. */
export function useInstalledDrafterModels(enabled: boolean) {
  const ids = useModelProvider(
    useShallow((state) => {
      if (!enabled) return []
      const provider = state.providers.find(
        (p) => p.provider === upstream && p.active !== false
      )
      return (
        provider?.models.filter(isAnswerableModel).map((model) => model.id) ??
        []
      )
    })
  )
  const [resolved, setResolved] = useState<{
    ids: string[]
    matches: Map<string, string[]>
  }>()
  useEffect(() => {
    let active = true
    if (!ids.length) return
    void Promise.allSettled(ids.map((id) => drafters.choices(id))).then(
      (results) => {
        if (!active) return
        const matches = new Map<string, string[]>()
        results.forEach((result, i) => {
          if (result.status !== 'fulfilled' || !result.value.target) return
          const target = result.value.target.toLowerCase()
          matches.set(target, [...(matches.get(target) ?? []), ids[i]])
        })
        setResolved({ ids, matches })
      }
    )
    return () => {
      active = false
    }
  }, [ids])
  return {
    loading: ids.length > 0 && resolved?.ids !== ids,
    matches: resolved?.ids === ids ? resolved.matches : undefined,
  }
}

export function drafterModelRepo(target: string, source?: string) {
  if (source) return source
  const entries = Object.values(atomicModelCatalogSnapshot().models)
  const checkpoint = target.toLowerCase()
  for (const { kind, definition, format, metadata } of entries) {
    if (
      kind === 'auxiliary' &&
      definition.method === 'dspark' &&
      String(definition.target).toLowerCase() === checkpoint &&
      typeof definition.target_repo === 'string'
    )
      return definition.target_repo
    if (
      kind === 'chat' &&
      format === 'gguf' &&
      typeof definition.model_name === 'string' &&
      Array.isArray(metadata?.tags) &&
      metadata.tags.some(
        (tag) =>
          typeof tag === 'string' &&
          tag.toLowerCase() === 'base_model:quantized:' + checkpoint
      )
    )
      return definition.model_name
  }
  return target
}
