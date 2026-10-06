import { useEffect, useState } from 'react'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import type { CuratedModel } from '@/services/managed-environment/types'
import type { CatalogModel } from '@/services/models/types'
import { describeDescriptor } from '@/services/managed-models/models'
import { managedVerdict, refusedOnEveryCard } from '@/services/managed-models/verdict'

/**
 * The curated models of a managed engine's descriptor that run on this machine, as Model Hub cards
 * (change `add-tensorrt-llm-model-hub`, design D3): the installation's descriptor, or the one the
 * plan would install (`useManagedHubStates()[…].hub.descriptorId`). Each is checked by that engine at
 * the revision the descriptor pins; one it refuses for every card of this machine is left out. Also
 * the descriptor's `supported_architectures`, which the Hugging Face feed is narrowed by.
 */
export interface ManagedCurated {
  models: CatalogModel[]
  /** `null` until the descriptor is read, and when the core does not hold it. */
  supportedArchitectures: string[] | null
  loading: boolean
}

const NONE: ManagedCurated = { models: [], supportedArchitectures: null, loading: false }

export function curatedCard(model: CuratedModel, engineId: string): CatalogModel {
  const [owner] = model.repository.split('/', 1)
  return {
    model_name: model.repository,
    developer: owner,
    description: model.note,
    downloads: 0,
    is_managed: true,
    managed: { curated: true, curatedBy: engineId, revision: model.revision },
    readme: `https://huggingface.co/${model.repository}/resolve/${model.revision}/README.md`,
  }
}

export function useManagedCurated(engineId: string, descriptorId: string | null): ManagedCurated {
  const token = useGeneralSetting((state) => state.huggingfaceToken) || undefined
  const [state, setState] = useState<ManagedCurated>(() =>
    descriptorId ? { ...NONE, loading: true } : NONE
  )

  useEffect(() => {
    if (!descriptorId) {
      setState(NONE)
      return
    }
    let cancelled = false
    setState((current) => ({ ...current, loading: true }))
    void (async () => {
      const summary = await describeDescriptor(descriptorId)
      if (cancelled) return
      if (!summary) {
        setState(NONE)
        return
      }
      // Side by side: each is a few small reads from Hugging Face and one network-free core check.
      const checked = await Promise.all(
        summary.curated_models.map(async (model) => ({
          model,
          verdict: await managedVerdict(engineId, descriptorId, model.repository, model.revision, token),
        }))
      )
      if (cancelled) return
      setState({
        models: checked
          .filter((entry) => !refusedOnEveryCard(entry.verdict))
          .map((entry) => curatedCard(entry.model, engineId)),
        supportedArchitectures: summary.supported_architectures,
        loading: false,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [engineId, descriptorId, token])

  return state
}
