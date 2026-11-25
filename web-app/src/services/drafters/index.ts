import { followCoreDownload } from '@/services/engine-builds/install'
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
export interface Drafter {
  sha256: string
  target: string
  repo: string
  file: string
  quant: string
  moreVariants?: boolean
  size: number
}
export interface DrafterInventory {
  files: Drafter[]
  downloads: { taskId: string; percent: number }[]
}
export interface DrafterSearch {
  target?: string
  results: Drafter[]
  hasMore?: boolean
  partial: boolean
}
export interface DrafterChoices {
  target?: string
  source?: string
  id: string | null
  files: Drafter[]
}
function call<T>(method: string, path: string, body: unknown = null) {
  return invoke<T>('atomic_core_call', { method, path, body })
}
const selectionPath = (model: string) =>
  '/models/llamacpp-upstream/' +
  model.split('/').map(encodeURIComponent).join('/') +
  '/drafter'
// A synchronous mirror for the chat routing and sampler, refreshed from core on selection.
export const useDsparkSelection = create<{
  ids: Record<string, string | null>
}>(() => ({ ids: {} }))
function remember(model: string, id: string | null) {
  useDsparkSelection.setState((state) => ({
    ids: { ...state.ids, [model]: id },
  }))
}
export const drafters = {
  selection: async (model: string) => {
    const result = await call<{ id: string | null }>(
      'GET',
      selectionPath(model) + '/selection'
    )
    remember(model, result.id)
    return result.id
  },
  list: () => call<DrafterInventory>('GET', '/drafters'),
  search: (
    source: string | undefined,
    target: string | undefined,
    q: string,
    live: boolean,
    page = 0
  ) => {
    const params = new URLSearchParams({
      q,
      live: live ? '1' : '0',
      page: String(page),
    })
    if (source) params.set('source', source)
    if (target) params.set('target', target)
    return call<DrafterSearch>('GET', '/drafters/search?' + params)
  },
  variants: (repo: string, target: string) =>
    call<DrafterSearch>(
      'GET',
      '/drafters/search?' + new URLSearchParams({ variants: repo, target })
    ),
  choices: async (model: string) => {
    const value = await call<DrafterChoices>('GET', selectionPath(model))
    remember(model, value.id)
    return value
  },
  select: async (model: string, id: string | null) => {
    await call('PUT', selectionPath(model), { id })
    remember(model, id)
  },
  install: (id: string) =>
    followCoreDownload('dspark:' + id, () =>
      call('POST', '/drafters/' + id + '/install')
    ),
  cancel: (id: string) => call('POST', '/drafters/' + id + '/cancel'),
  remove: async (id: string) => {
    await call('DELETE', '/drafters/' + id)
    for (const [model, selected] of Object.entries(
      useDsparkSelection.getState().ids
    ))
      if (selected === id) remember(model, null)
  },
}
export function drafterError(error: unknown) {
  return error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error)
}
