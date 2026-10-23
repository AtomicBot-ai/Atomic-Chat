/**
 * The provider the Local API Server page shows for each model id, handed to
 * the server so a request for that id goes where the page says (AC-03).
 *
 * Without it the server routed by id alone: a custom endpoint that lists the
 * same id as a local model won every request, while the page showed the local
 * engine the user had switched back to. The server now sends an id selected on
 * a cloud provider to that provider only, keeps one selected on a local engine
 * local (that engine first, then any other), and answers 503 naming both when
 * no local engine has it. Ids not listed here keep the server's own rules. ADR 2026-10-21-the-server-routes-a-model-id-to-the-provider-selected-for-it.
 */

import { invoke } from '@tauri-apps/api/core'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { isPlatformTauri } from '@/lib/platform/utils'

export type ServedModelSelection = { model: string; provider: string }

type SelectionSource = {
  lastServerModels: ServedModelSelection[]
  defaultModelLocalApiServer: ServedModelSelection | null
}

/**
 * One provider per model id, as the server page shows it: the models the
 * running server was last given first (what the page shows while it runs),
 * then the configured default. The first entry for an id wins.
 */
export function servedModelSelection(
  state: SelectionSource
): ServedModelSelection[] {
  const seen = new Set<string>()
  const selection: ServedModelSelection[] = []
  const candidates = [
    ...state.lastServerModels,
    ...(state.defaultModelLocalApiServer
      ? [state.defaultModelLocalApiServer]
      : []),
  ]
  for (const { model, provider } of candidates) {
    if (!model || !provider || seen.has(model)) continue
    seen.add(model)
    selection.push({ model, provider })
  }
  return selection
}

/**
 * Send the selection to the server. Never throws: a core older than the
 * selection keeps routing by its own rules, which is no reason to fail
 * anything the user did.
 */
export async function sendServedModelSelection(
  models: ServedModelSelection[]
): Promise<void> {
  if (!isPlatformTauri()) return
  try {
    await invoke('set_server_model_selection', { models })
  } catch (error) {
    console.warn(
      '[LocalAPI] the server did not take the model selection:',
      error
    )
  }
}

/**
 * Keep the server's routing in step with the server page: send the selection
 * now and after every change to it. Returns the unsubscribe.
 */
export function syncServedModelSelection(): () => void {
  let last = ''
  const send = (state: SelectionSource) => {
    const models = servedModelSelection(state)
    const key = JSON.stringify(models)
    if (key === last) return
    last = key
    void sendServedModelSelection(models)
  }
  send(useLocalApiServer.getState())
  return useLocalApiServer.subscribe(send)
}
