/**
 * The HTTP client the media adapters use inside the app.
 *
 * The webview's own `fetch` is subject to CORS, and not every provider allows
 * a browser origin: Replicate's API sends no CORS headers at all, and a local
 * AUTOMATIC1111 only does when started with `--cors-allow-origins`. The Tauri
 * HTTP plugin sends the request from the Rust side, where CORS does not apply,
 * and is already scoped to http(s) in the app's capabilities. It honours
 * `AbortSignal` and hands back headers before the body, which the synchronous
 * adapters rely on.
 *
 * Outside Tauri (tests, the web build) the global `fetch` is used, looked up
 * per call so a test's stub is seen.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import type { MediaTransport } from './adapters/http'

function isTauriRuntime(): boolean {
  try {
    return typeof IS_TAURI !== 'undefined' && Boolean(IS_TAURI)
  } catch {
    return false
  }
}

export const mediaTransport: MediaTransport = (input, init) =>
  isTauriRuntime()
    ? (fetchTauri(input, init) as Promise<Response>)
    : globalThis.fetch(input, init)
