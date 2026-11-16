import { EngineManager } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import type {
  StrataCheckRequest,
  StrataCheckResult,
  StrataPreparationOperation,
  StrataPreparationRequest,
} from '@atomic-chat/core/contracts'

export async function syncStrataSettings() {
  const engine = EngineManager.instance().get('strata') as
    | { syncSettings?: () => Promise<void> }
    | undefined
  await engine?.syncSettings?.()
}

export function checkStrataModel(body: StrataCheckRequest) {
  return invoke<StrataCheckResult>('atomic_core_call', {
    method: 'POST',
    path: '/models/strata/check',
    body,
  })
}

const preparations = '/strata/preparations'

export function listStrataPreparations() {
  return invoke<StrataPreparationOperation[]>('atomic_core_call', {
    method: 'GET',
    path: preparations,
    body: null,
  })
}

export function beginStrataPreparation(body: StrataPreparationRequest) {
  return invoke<StrataPreparationOperation>('atomic_core_call', {
    method: 'POST',
    path: preparations,
    body,
  })
}

export function changeStrataPreparation(
  id: string,
  action: 'cancel' | 'resume'
) {
  return invoke<StrataPreparationOperation>('atomic_core_call', {
    method: 'POST',
    path: `${preparations}/${encodeURIComponent(id)}/${action}`,
    body: {},
  })
}

export function readStrataPreparation(id: string) {
  return invoke<StrataPreparationOperation>('atomic_core_call', {
    method: 'GET',
    path: `${preparations}/${encodeURIComponent(id)}`,
    body: null,
  })
}
