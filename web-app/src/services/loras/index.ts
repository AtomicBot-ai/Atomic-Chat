import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { followCoreDownload } from '@/services/engine-builds/install'
export type LoraMode = 'chat' | 'image' | 'video'
export interface Lora {
  sha256: string
  repo: string
  file: string
  target: string
  size: number
  mode: LoraMode
}
export interface LoraChoices {
  source?: string
  target?: string
  adapterId: string | null
  files: Lora[]
}
export interface LoraInventory {
  files: Lora[]
  downloads: { taskId: string; percent: number }[]
}
function call<T>(method: string, path: string, body: unknown = null) {
  return invoke<T>('atomic_core_call', { method, path, body })
}
const choicePath = (mode: LoraMode, model: string) =>
  '/loras/choices/' +
  mode +
  '/' +
  model.split('/').map(encodeURIComponent).join('/')
export const useLoraInventoryVersion = create<{ version: number }>(() => ({
  version: 0,
}))
function changed() {
  useLoraInventoryVersion.setState((s) => ({ version: s.version + 1 }))
}
export const loras = {
  choices: (mode: LoraMode, model: string) =>
    call<LoraChoices>('GET', choicePath(mode, model)),
  select: (mode: LoraMode, model: string, adapterId: string | null) =>
    call('PUT', choicePath(mode, model), { adapterId }),
  list: () => call<LoraInventory>('GET', '/loras'),
  search: (
    q: string,
    target: string | undefined,
    live: boolean,
    source?: string,
    repoOnly = false
  ) => {
    const params = new URLSearchParams({ q, live: live ? '1' : '0' })
    if (repoOnly) params.set('scope', 'repo')
    if (source) params.set('source', source)
    if (target) params.set('target', target)
    return call<{ results: Lora[]; partial: boolean; target?: string }>(
      'GET',
      '/loras/search?' + params
    )
  },
  install: async (id: string) => {
    await followCoreDownload('lora:' + id, () =>
      call('POST', '/loras/' + id + '/install')
    )
    changed()
  },
  cancel: (id: string) => call('POST', '/loras/' + id + '/cancel'),
  remove: async (id: string) => {
    await call('DELETE', '/loras/' + id)
    changed()
  },
}
export function loraError(e: unknown) {
  return e && typeof e === 'object' && 'message' in e
    ? String(e.message)
    : String(e)
}
