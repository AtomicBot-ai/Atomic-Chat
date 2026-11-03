/**
 * The model a chat opened in its own window starts on (QA 2.2.29 B12).
 *
 * Every window runs its own copy of the web app. With "Preload model on
 * startup" off a new one starts with nothing selected (main.tsx), and the
 * model picker then reselects a running model by its id. Both llama.cpp
 * providers list the same models folder, so an id does not say which engine
 * it belongs to: the new window took TurboQuant for a model upstream was
 * serving, and loaded it there.
 *
 * So the opening window hands its selection, provider and model together,
 * to the new window in its URL, and the new window selects exactly that
 * before anything renders.
 */
import { useModelProvider } from '@/hooks/useModelProvider'

/** The thread route's own search key, in the router's JSON format. */
const THREAD_MODEL_PARAM = 'threadModel'

/** The URL that opens a thread in its own window, on this window's model. */
export function threadWindowUrl(threadId: string): string {
  const path = `/threads/${threadId}`
  const { selectedProvider, selectedModel } = useModelProvider.getState()
  if (!selectedProvider || !selectedModel?.id) return path
  const model: ThreadModel = {
    id: selectedModel.id,
    provider: selectedProvider,
  }
  return `${path}?${THREAD_MODEL_PARAM}=${encodeURIComponent(JSON.stringify(model))}`
}

function readThreadModel(search: string): ThreadModel | undefined {
  const raw = new URLSearchParams(search).get(THREAD_MODEL_PARAM)
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Partial<ThreadModel> | null
    return typeof value?.id === 'string' && typeof value.provider === 'string'
      ? { id: value.id, provider: value.provider }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Select the model a thread window was opened on. Runs before React mounts,
 * so the picker's startup check finds a selection and keeps it. A provider
 * switched off or a model deleted since leaves that check in charge.
 */
export function restoreThreadWindowModel(
  location: Pick<Location, 'pathname' | 'search'> = window.location
): void {
  if (!location.pathname.startsWith('/threads/')) return
  const model = readThreadModel(location.search)
  if (!model) return
  const state = useModelProvider.getState()
  const provider = state.getProviderByName(model.provider)
  if (
    !provider ||
    provider.active === false ||
    !provider.models.some((candidate) => candidate.id === model.id)
  ) {
    return
  }
  state.selectModelProvider(model.provider, model.id)
}
