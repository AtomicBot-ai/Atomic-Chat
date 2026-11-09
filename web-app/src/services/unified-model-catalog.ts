/** All production collection adapters read the same complete catalog snapshot. */
import { invoke } from '@tauri-apps/api/core'
import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import {
  loadAtomicModelCatalog,
  configureAtomicModelCatalogSource,
  projectAtomicModelCollection,
  atomicModelCatalogStatus,
  atomicModelCatalogBaseline,
  atomicModelCatalogSnapshot,
  configureAtomicModelMetadataFetch,
} from '@janhq/core'
import { useProxyConfig } from '@/hooks/useProxyConfig'

const url = import.meta.env.VITE_ATOMIC_MODEL_CATALOG_URL as string | undefined
configureAtomicModelCatalogSource(url)

/** Detach cancellation after consuming the native response; a later timeout must not close an already released resource. */
export async function nativeMetadata(
  input: Parameters<typeof fetchTauri>[0],
  init: Parameters<typeof fetchTauri>[1]
): Promise<Response> {
  const controller = new AbortController()
  const signal = init?.signal
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetchTauri(input, {
      ...init,
      signal: controller.signal,
    })
    const body = await response.arrayBuffer()
    return new Response([204, 304].includes(response.status) ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

/** New metadata requests honour the same proxy and TLS choices as file transfers. */
const metadataRequest: typeof fetch = async (input, init) => {
  const state = useProxyConfig.getState()
  if (
    typeof IS_TAURI !== 'undefined' &&
    IS_TAURI &&
    state.proxyEnabled &&
    state.proxyUrl
  ) {
    return nativeMetadata(input, {
      ...init,
      proxy: {
        all: {
          url: state.proxyUrl,
          noProxy: state.noProxy,
          ...(state.proxyUsername && state.proxyPassword
            ? {
                basicAuth: {
                  username: state.proxyUsername,
                  password: state.proxyPassword,
                },
              }
            : {}),
        },
      },
      danger: {
        acceptInvalidCerts: state.proxyIgnoreSSL || !state.verifyPeerSSL,
        acceptInvalidHostnames: state.proxyIgnoreSSL || !state.verifyHostSSL,
      },
    })
  }
  try {
    return await fetch(input, init)
  } catch (error) {
    if (typeof IS_TAURI === 'undefined' || !IS_TAURI) throw error
    return nativeMetadata(input, init)
  }
}
configureAtomicModelMetadataFetch(metadataRequest)

const request: typeof fetch = async (input, init) => {
  const target = String(input)
  if (target.startsWith('file://')) {
    const path = decodeURIComponent(new URL(target).pathname).replace(
      /^\/([A-Za-z]:\/)/,
      '$1'
    )
    return new Response(
      await invoke<string>('read_file_sync', { args: [path] })
    )
  }
  return metadataRequest(input, init)
}

export async function unifiedModelCollection(name: string, force = false) {
  const catalog = await loadAtomicModelCatalog({
    ...(url ? { url } : {}),
    fetch: request,
    force,
  })
  return {
    data: projectAtomicModelCollection(catalog, name),
    ...atomicModelCatalogStatus(),
    updatedAt: catalog.updated_at,
  }
}

export function unifiedModelBaseline(name: string): unknown {
  return projectAtomicModelCollection(atomicModelCatalogBaseline(), name)
}

export function unifiedModelSnapshot(name: string): Record<string, unknown> {
  return projectAtomicModelCollection(atomicModelCatalogSnapshot(), name)
}

/** Mobile keeps its existing catalogs and cache contracts. */
export function usesUnifiedModelCatalog(): boolean {
  return (
    !(typeof IS_IOS !== 'undefined' && IS_IOS) &&
    !(typeof IS_ANDROID !== 'undefined' && IS_ANDROID)
  )
}

export async function unifiedModelCatalog(force = false) {
  return loadAtomicModelCatalog({
    ...(url ? { url } : {}),
    fetch: request,
    force,
  })
}
