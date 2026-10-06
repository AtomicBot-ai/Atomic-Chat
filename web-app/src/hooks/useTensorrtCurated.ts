import { useEffect, useState } from 'react'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import type { CuratedModel } from '@/services/managed-environment/types'
import type { CatalogModel } from '@/services/models/types'
import { describeDescriptor } from '@/services/tensorrt-llm/models'
import { refusedOnEveryCard, tensorrtVerdict } from '@/services/tensorrt-llm/verdict'

/**
 * The curated models of a TensorRT-LLM descriptor that run on this machine, as Model Hub cards
 * (change `add-tensorrt-llm-model-hub`, design D3): the installation's descriptor, or the one the
 * plan would install (`useTensorrtHubState().descriptorId`). Each is checked by the core at the
 * revision the descriptor pins; one the core refuses for every card of this machine is left out. Also the
 * descriptor's `supported_architectures`, which the Hugging Face feed is narrowed by.
 */
export interface TensorrtCurated {
  models: CatalogModel[]
  /** `null` until the descriptor is read, and when the core does not hold it. */
  supportedArchitectures: string[] | null
  loading: boolean
}

const NONE: TensorrtCurated = { models: [], supportedArchitectures: null, loading: false }

export function curatedCard(model: CuratedModel): CatalogModel {
  const [owner] = model.repository.split('/', 1)
  return {
    model_name: model.repository,
    developer: owner,
    description: model.note,
    downloads: 0,
    is_tensorrt_llm: true,
    tensorrt: { curated: true, revision: model.revision },
    readme: `https://huggingface.co/${model.repository}/resolve/${model.revision}/README.md`,
  }
}

export function useTensorrtCurated(descriptorId: string | null): TensorrtCurated {
  const token = useGeneralSetting((state) => state.huggingfaceToken) || undefined
  const [state, setState] = useState<TensorrtCurated>(() =>
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
          verdict: await tensorrtVerdict(model.repository, model.revision, token),
        }))
      )
      if (cancelled) return
      setState({
        models: checked
          .filter((entry) => !refusedOnEveryCard(entry.verdict))
          .map((entry) => curatedCard(entry.model)),
        supportedArchitectures: summary.supported_architectures,
        loading: false,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [descriptorId, token])

  return state
}
