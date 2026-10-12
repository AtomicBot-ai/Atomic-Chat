import { useLayoutEffect, useRef } from 'react'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  isLocalEngineProvider,
  isProviderConnected,
} from '@/lib/cloud-providers'

type SavedModel = { id: string; provider: string }

/** Restore once on entry; provider refreshes must never undo an explicit pick. */
export function useThreadModelSelection(
  threadId: string,
  saved: SavedModel | undefined,
  loaded: boolean
): SavedModel | undefined {
  const providers = useModelProvider((state) => state.providers)
  const selected = useModelProvider((state) => state.selectedModel)
  const entry = useRef<{ threadId: string; restored: boolean } | null>(null)
  const provider = providers.find((item) => item.provider === saved?.provider)
  const available = Boolean(
    provider?.active &&
    (isLocalEngineProvider(provider) || isProviderConnected(provider)) &&
    provider.models.some(
      (model) => model.id === saved?.id && !model.embedding && !model.missing
    )
  )

  useLayoutEffect(() => {
    if (!loaded) return
    const state = useModelProvider.getState()
    const entering = entry.current?.threadId !== threadId
    if (entering) entry.current = { threadId, restored: false }
    if (!saved) return
    // Retry a library that arrived after entry, but only while the composer is
    // still empty. A model chosen by the user always wins within this chat.
    if (!entering && (entry.current?.restored || state.selectedModel)) return
    if (available) {
      state.selectModelProvider(saved.provider, saved.id)
      entry.current!.restored = true
    } else if (entering) {
      state.selectModelProvider('', '')
    }
  }, [
    threadId,
    saved?.id,
    saved?.provider,
    saved,
    loaded,
    available,
    providers,
  ])

  return loaded && saved && !available && !selected ? saved : undefined
}
