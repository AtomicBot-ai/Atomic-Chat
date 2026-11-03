import { listen } from '@tauri-apps/api/event'
import { useEffect, useState } from 'react'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { LOCAL_CONTEXT_PROVIDERS } from '@/hooks/useModelContextLength'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { isPlatformTauri } from '@/lib/platform/utils'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import {
  getModelContextLength,
  readLoadedContextLength,
} from '@/utils/apiServerCapacity'
import { findServingProvider } from '@/utils/ensureModelForServer'

/**
 * Core events after which a loaded model may run with another window: every
 * load starts a session, the core's reload with a bigger window included.
 */
const RELOAD_EVENTS = [
  'atomic-core://session:started',
  'atomic-core://session:ctx-increased',
]

/**
 * The context window clients get from the loaded `modelId`: the one its
 * running session was loaded with, read from the engine that holds it and
 * read again after every reload. Until the engine has said, or when it cannot
 * (MLX), that engine's own `ctx_len` setting; nothing for an engine with no
 * context setting.
 *
 * Never the first provider's setting that names the id: both llama.cpp
 * providers list the same models, so that read TurboQuant's untouched 16,384
 * while llama.cpp ran the model at the 4,096 set for chat (QA B09).
 */
export function useServedContextLength(
  modelId: string | null
): number | undefined {
  const serviceHub = useServiceHub()
  const preferredProvider = useLocalApiServer((state) => {
    const served = state.lastServerModels.find((m) => m.model === modelId)
    if (served) return served.provider
    const fallback = state.defaultModelLocalApiServer
    return fallback?.model === modelId ? fallback.provider : undefined
  })
  const [reloads, setReloads] = useState(0)
  const [resolved, setResolved] = useState<{
    modelId: string
    provider?: string
    loaded?: number
  } | null>(null)

  useEffect(() => {
    if (!isPlatformTauri()) return
    let cancelled = false
    const detach: Array<() => Promise<void>> = []
    for (const name of RELOAD_EVENTS) {
      listen(name, () => setReloads((count) => count + 1))
        .then((unlisten) => {
          const safe = createSafeUnlisten(unlisten)
          if (cancelled) void safe()
          else detach.push(safe)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
      detach.forEach((unlisten) => void unlisten())
    }
  }, [])

  useEffect(() => {
    if (!modelId) return
    let cancelled = false
    void (async () => {
      const provider = await findServingProvider(
        modelId,
        serviceHub.models(),
        preferredProvider
      ).catch(() => undefined)
      const loaded = provider
        ? await readLoadedContextLength(provider.provider, modelId)
        : undefined
      if (!cancelled)
        setResolved({ modelId, provider: provider?.provider, loaded })
    })()
    return () => {
      cancelled = true
    }
  }, [modelId, preferredProvider, reloads, serviceHub])

  const current = resolved?.modelId === modelId ? resolved : null
  const provider = current?.provider
  const configured = useModelProvider((state) =>
    modelId && provider && LOCAL_CONTEXT_PROVIDERS.has(provider)
      ? getModelContextLength(modelId, provider, state.providers)
      : undefined
  )
  return current?.loaded ?? configured
}
