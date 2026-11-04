/**
 * Typed transport failures from the Rust loopback HTTP commands (`stream_local_http`,
 * `post_local_http` in src-tauri/src/core/http.rs).
 *
 * Rust prefixes every transport error string with `[transport:<kind>] `. The text after the
 * token is the raw OS / hyper message: it is localized on Windows ("No connection could be
 * made…", or the same in German or Russian) and must never be matched on. Classify on the kind.
 *
 * - `connect_refused`  nothing listens on the port (engine not started, or it died) — os error 61/111/10061
 * - `connect_timeout`  the TCP connect did not finish in time
 * - `connection_reset` the peer reset or aborted an open connection — os error 54/104/10053/10054
 * - `body_eof`         the response body ended mid-stream (chunked EOF, closed before message end)
 * - `idle_timeout`     no response headers / no data within the idle budget
 * - `request_failed`   any other reqwest error before a response arrived
 */
export const TRANSPORT_KINDS = [
  'connect_refused',
  'connect_timeout',
  'connection_reset',
  'body_eof',
  'idle_timeout',
  'request_failed',
] as const

export type TransportKind = (typeof TRANSPORT_KINDS)[number]

const TRANSPORT_TOKEN = /\[transport:([a-z_]+)\]/

/** The kind from an error, its message, or a raw string; undefined when Rust did not tag it. */
export function parseTransportKind(error: unknown): TransportKind | undefined {
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : undefined
  if (!text) return undefined
  const match = TRANSPORT_TOKEN.exec(text)
  const kind = match?.[1]
  return (TRANSPORT_KINDS as readonly string[]).includes(kind ?? '')
    ? (kind as TransportKind)
    : undefined
}

/** The local engine is gone (never listened, or dropped the connection mid-turn). */
export function isEngineGoneKind(kind: TransportKind | undefined): boolean {
  return (
    kind === 'connect_refused' ||
    kind === 'connection_reset' ||
    kind === 'body_eof'
  )
}

/** `(os error 10061)` → 10061. */
export function parseOsErrorCode(text: string | undefined | null): number | undefined {
  if (!text) return undefined
  const match = /\(os error (\d+)\)/.exec(text)
  return match ? Number(match[1]) : undefined
}

/** Build a tagged message the way Rust does; for tests and for web-side fallbacks. */
export function formatTransportError(kind: TransportKind, message: string): string {
  return `[transport:${kind}] ${message}`
}
