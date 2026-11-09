import { useCallback, useEffect, useMemo, useState } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import {
  activateLocalDecisionModel,
  isActiveLocalDecisionModel,
  localDecisionKey,
  stopDecisionModel,
  type LocalDecisionModel,
} from '@/lib/decision/models'
import { readLocalEmbeddingModel } from '@/lib/embedding/models'
import { LLAMACPP_PROVIDERS } from '@/lib/hub-installed'
import { getModelDisplayName } from '@/lib/utils'
import type {
  DecisionCoreError,
  DecisionState,
} from '@/services/decision/types'
import { toDecisionError, useDecisionStore } from '@/stores/decision-store'
import { raiseLocalApiServerForMediaModel } from '@/utils/localApiServerControl'

/**
 * The decision models the catalog does not name: the llama.cpp models the
 * extensions flagged as decision GGUFs (both llama.cpp providers list one
 * models folder, so an id counts once), then the models put by hand into
 * `decision/models`. The store's folder list follows `bind()`, which the
 * pages showing decision models already call.
 */
export function useLocalDecisionModels(): LocalDecisionModel[] {
  const providers = useModelProvider((state) => state.providers)
  const folderModels = useDecisionStore((state) => state.folderModels)
  const candidates = useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const name of LLAMACPP_PROVIDERS) {
      const provider = providers.find((entry) => entry.provider === name)
      for (const model of provider?.models ?? []) {
        if (model.decision !== true || model.missing || seen.has(model.id))
          continue
        seen.add(model.id)
        out.push({ id: model.id, name: getModelDisplayName(model) })
      }
    }
    return out
  }, [providers])
  const [llamacpp, setLlamacpp] = useState<LocalDecisionModel[]>([])

  useEffect(() => {
    let cancelled = false
    // The paths come from the model's `model.yml`, read the same way as an
    // embedding GGUF's.
    void Promise.all(
      candidates.map(({ id, name }) => readLocalEmbeddingModel(id, name))
    ).then((rows) => {
      if (cancelled) return
      setLlamacpp(
        rows.flatMap((row) =>
          row
            ? [
                {
                  key: localDecisionKey('llamacpp', row.id),
                  id: row.id,
                  name: row.name,
                  source: 'llamacpp' as const,
                  model_path: row.model_path,
                  mmproj_path: row.mmproj_path,
                },
              ]
            : []
        )
      )
    })
    return () => {
      cancelled = true
    }
  }, [candidates])

  return useMemo(() => [...llamacpp, ...folderModels], [llamacpp, folderModels])
}

export type LocalDecisionModelState = {
  /** The core is configured to run this model and it is switched on. */
  running: boolean
  /** The core's state while this model is running, else `null`. */
  state: DecisionState | null
  /** A start or stop of this model is in flight. */
  busy: boolean
  /** Why the last start or stop of this model failed; cleared by the next one. */
  error: DecisionCoreError | null
  activate: () => Promise<void>
  stop: () => Promise<void>
}

/** Start / stop for one model the catalog does not name, as `useDecisionModel` does for a catalog one. */
export function useLocalDecisionModel(
  model: LocalDecisionModel
): LocalDecisionModelState {
  const config = useDecisionStore((state) => state.config)
  const status = useDecisionStore((state) => state.status)
  const busyId = useDecisionStore((state) => state.busy)
  const [error, setError] = useState<DecisionCoreError | null>(null)
  const running =
    isActiveLocalDecisionModel(config, model) && Boolean(config?.enabled)

  const run = useCallback(
    async (action: () => Promise<void>) => {
      const store = useDecisionStore.getState()
      store.setBusy(model.key)
      setError(null)
      try {
        await action()
        store.setError(null)
      } catch (caught) {
        const failure = toDecisionError(caught)
        store.setError(failure)
        setError(failure)
      } finally {
        store.setBusy(null)
        await store.refresh()
      }
    },
    [model.key]
  )

  const activate = useCallback(
    () =>
      run(async () => {
        await activateLocalDecisionModel(model)
        // Clients reach `/v1/systemone` only through the Local API Server.
        void raiseLocalApiServerForMediaModel()
      }),
    [model, run]
  )

  const stop = useCallback(() => run(stopDecisionModel), [run])

  return {
    running,
    state: running ? (status?.state ?? null) : null,
    busy: busyId === model.key,
    error,
    activate,
    stop,
  }
}
