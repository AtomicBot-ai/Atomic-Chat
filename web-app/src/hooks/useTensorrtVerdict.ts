import { useEffect, useState } from 'react'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import type { CatalogModel } from '@/services/models/types'
import {
  heldManagedVerdict,
  managedVerdict,
  type ManagedVerdict as TensorrtVerdict,
} from '@/services/managed-models/verdict'

/**
 * The core's verdict for a TensorRT-LLM card of the Model Hub (design D5): asked when the card
 * opens, at the curated revision when there is one, and kept for the session — a card opened
 * again reads it without asking. `null` for a model of another format.
 */
export function useTensorrtVerdict(model: CatalogModel | null): {
  verdict: TensorrtVerdict | null
  /** Asked and not answered yet. */
  checking: boolean
} {
  const token = useGeneralSetting((state) => state.huggingfaceToken) || undefined
  const repository = model?.is_tensorrt_llm ? model.model_name : null
  const revision = model?.tensorrt?.revision
  const key = repository ? `${repository}@${revision ?? 'main'}` : null
  const [answer, setAnswer] = useState<{ key: string; verdict: TensorrtVerdict } | null>(() => {
    const held = repository ? heldManagedVerdict('tensorrt-llm', repository, revision) : undefined
    return key && held ? { key, verdict: held } : null
  })

  useEffect(() => {
    if (!repository || !key) return
    let cancelled = false
    void managedVerdict('tensorrt-llm', repository, revision, token).then((verdict) => {
      if (!cancelled) setAnswer({ key, verdict })
    })
    return () => {
      cancelled = true
    }
  }, [repository, revision, key, token])

  // The answer of the card shown before this one is not this card's.
  const held = repository ? heldManagedVerdict('tensorrt-llm', repository, revision) : undefined
  const verdict = answer?.key === key ? answer.verdict : (held ?? null)
  return { verdict, checking: repository !== null && verdict === null }
}
