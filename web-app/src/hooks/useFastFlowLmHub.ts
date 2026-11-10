import { useEffect, useState } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import { fetchFastFlowLmModels } from '@/services/fastflowlm/catalog'
import type { CatalogModel } from '@/services/models/types'

export function useFastFlowLmHubVisible() {
  return useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === 'fastflowlm')
  )
}

/** A cancelled view cannot replace the next format's results. No HF search is offered for FLM. */
export function useFastFlowLmHub(enabled: boolean) {
  const [models, setModels] = useState<CatalogModel[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!enabled) return
    let alive = true
    setLoading(true)
    void fetchFastFlowLmModels()
      .then((entries) => {
        if (!alive) return
        setModels(
          entries.map((model) => ({
            model_name: `fastflowlm/${model.variant_id}`,
            description: model.name,
            downloads: 0,
            is_fastflowlm: true,
            tools: model.capabilities.tools,
            fastflowlm: model,
          }))
        )
        setError(undefined)
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
      .finally(() => {
        if (alive) {
          setLoading(false)
          setLoaded(true)
        }
      })
    return () => {
      alive = false
    }
  }, [enabled])
  return { models, loading, loaded, error }
}
