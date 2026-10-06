import { useEffect, useMemo, useState } from 'react'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useManagedHubStates } from '@/hooks/useManagedHubState'
import type { ManagedHubState } from '@/lib/managed-engine/hub-state'
import type { ManagedEngine } from '@/lib/managed-engines'
import type { CatalogModel } from '@/services/models/types'
import {
  heldManagedVerdict,
  managedVerdict,
  type ManagedVerdict,
} from '@/services/managed-models/verdict'

export interface EngineVerdict {
  engine: ManagedEngine
  /** The engine in the Hub: installed, not installed, blocked; and its descriptor. */
  hub: ManagedHubState
  /** The engine's own verdict; `null` until it answers. */
  verdict: ManagedVerdict | null
  /** Asked and not answered yet (or not askable yet: the engine's descriptor is not known). */
  checking: boolean
}

/**
 * Each visible managed engine's verdict on a safetensors card of the Model Hub (spec `vllm-desktop`,
 * "Карточка модели показывает вердикт каждого managed-движка"; design D5, D14), in registry order —
 * vLLM first. An engine is asked once its descriptor is known (its installation's, else the one its
 * plan would install), at the curated revision when there is one; the answer is kept for the
 * session by engine, descriptor and `repository@revision`, so a card opened again reads it without
 * asking. Empty for a model of another format.
 */
export function useManagedVerdicts(model: CatalogModel | null): EngineVerdict[] {
  const token = useGeneralSetting((state) => state.huggingfaceToken) || undefined
  const states = useManagedHubStates()
  const repository = model?.is_managed ? model.model_name : null
  const revision = model?.managed?.revision
  const visible = useMemo(
    () => (repository ? states.filter((entry) => entry.hub.visible) : []),
    [repository, states]
  )
  // What to ask: one line per engine whose descriptor is known.
  const asks = visible
    .filter((entry) => entry.hub.descriptorId !== null)
    .map((entry) => `${entry.engine.id}\u0000${entry.hub.descriptorId}`)
    .join('\u0001')
  const [answers, setAnswers] = useState<Record<string, ManagedVerdict>>({})

  useEffect(() => {
    if (!repository || asks === '') return
    let cancelled = false
    for (const ask of asks.split('\u0001')) {
      const [engineId, descriptorId] = ask.split('\u0000')
      void managedVerdict(engineId, descriptorId, repository, revision, token).then((verdict) => {
        if (cancelled) return
        const key = `${ask}\u0000${repository}@${revision ?? 'main'}`
        setAnswers((held) => ({ ...held, [key]: verdict }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [asks, repository, revision, token])

  return visible.map(({ engine, hub }) => {
    if (!repository || hub.descriptorId === null) {
      return { engine, hub, verdict: null, checking: true }
    }
    // The answer of the card shown before this one is not this card's.
    const key = `${engine.id}\u0000${hub.descriptorId}\u0000${repository}@${revision ?? 'main'}`
    const verdict =
      answers[key] ?? heldManagedVerdict(engine.id, hub.descriptorId, repository, revision) ?? null
    return { engine, hub, verdict, checking: verdict === null }
  })
}
