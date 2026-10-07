/**
 * The four `/engine-builds/:engine/*` routes of the core, through the Rust
 * relay (`atomic_core_call`). The install call has no client deadline
 * (`control_call_timeout`): it downloads inside the request, and progress and
 * cancellation go through the core's `download:*` events and
 * `POST /downloads/:task_id/cancel` under the caller's `task_id`.
 *
 * A failure rejects with the relay's plain `{code, message, details?}`.
 */

import { invoke } from '@tauri-apps/api/core'

import { useProxyConfig } from '@/hooks/useProxyConfig'

import type {
  EngineBuildCatalog,
  EngineBuildCatalogRequest,
  EngineBuildId,
  EngineBuildInstallRequest,
  EngineBuildInstallResult,
  EngineBuildProxy,
  EngineBuildRemoveResult,
  EngineBuildUpdateCheck,
  EngineBuildUpdateCheckRequest,
} from './types'

const call = <T>(method: 'POST' | 'DELETE', path: string, body: unknown = null) =>
  invoke<T>('atomic_core_call', { method, path, body })

const base = (engine: EngineBuildId) => `/engine-builds/${engine}`

export function engineBuildCatalog(
  engine: EngineBuildId,
  request: EngineBuildCatalogRequest = {}
): Promise<EngineBuildCatalog> {
  return call('POST', `${base(engine)}/catalog`, request)
}

export function checkEngineBuildUpdates(
  engine: EngineBuildId,
  request: EngineBuildUpdateCheckRequest = {}
): Promise<EngineBuildUpdateCheck> {
  return call('POST', `${base(engine)}/updates`, request)
}

export function installEngineBuild(
  engine: EngineBuildId,
  request: EngineBuildInstallRequest
): Promise<EngineBuildInstallResult> {
  return call('POST', `${base(engine)}/install`, request)
}

export function removeEngineBuild(
  engine: EngineBuildId,
  tag: string,
  backendId: string
): Promise<EngineBuildRemoveResult> {
  return call(
    'DELETE',
    `${base(engine)}/${encodeURIComponent(tag)}/${encodeURIComponent(backendId)}`
  )
}

/** The app's HTTPS proxy setting in the core's `ProxyConfig` shape, or `undefined` when off. */
export function engineBuildProxy(): EngineBuildProxy | undefined {
  const state = useProxyConfig.getState()
  if (!state.proxyEnabled || !state.proxyUrl) return undefined
  const noProxy = state.noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return {
    url: state.proxyUrl,
    ...(state.proxyUsername && state.proxyPassword
      ? { username: state.proxyUsername, password: state.proxyPassword }
      : {}),
    ...(noProxy.length > 0 ? { no_proxy: noProxy } : {}),
    ignore_ssl: state.proxyIgnoreSSL,
  }
}
