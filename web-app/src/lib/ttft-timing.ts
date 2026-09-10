/**
 * Wall-clock markers for end-to-end TTFT diagnosis (dev / optional prod logging).
 *
 * α — send click / processAndSendMessage start
 * β — after processAttachmentsForSend
 * γ — refreshTools start / end
 * δ — ModelFactory.createModel start / end
 * ε — stream_local_http invoke / first IPC chunk
 * ζ — (Rust) proxy request received / upstream headers
 * η — (Rust) llama first token / prompt_eval logged
 * θ — first non-empty content rendered in RenderMarkdown
 */

export type TtftMarker =
  | 'alpha'
  | 'beta'
  | 'gammaStart'
  | 'gammaEnd'
  | 'deltaStart'
  | 'deltaEnd'
  | 'epsilonInvoke'
  | 'epsilonFirstChunk'
  | 'zetaProxyIn'
  | 'zetaUpstreamHeaders'
  | 'etaFirstToken'
  | 'thetaFirstRender'

export interface TtftTimings {
  alpha?: number
  beta?: number
  gammaStart?: number
  gammaEnd?: number
  deltaStart?: number
  deltaEnd?: number
  epsilonInvoke?: number
  epsilonFirstChunk?: number
  zetaProxyIn?: number
  zetaUpstreamHeaders?: number
  etaFirstToken?: number
  thetaFirstRender?: number
}

/**
 * Gates the developer `console.table` report only. Marker *collection* is
 * unconditional: each mark is a single `Date.now()`, and the deltas are the
 * only way to tell — on a user's real hardware — whether a slow first token is
 * the client, the proxy or the engine. `ttftSnapshot()` feeds them into
 * `chat_response_received`.
 */
const TTFT_REPORT_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_TTFT_TIMING === 'true'

let active: TtftTimings | null = null
let reported = false

// #region agent log
function ttftDebugLog(
  _location: string,
  _message: string,
  _data?: Record<string, unknown>
): void {
  void _location
  void _message
  void _data
}

export function ttftPreBegin(label: string, data?: Record<string, unknown>): void {
  ttftDebugLog('ttft-timing.ts:preBegin', label, {
    ...data,
    sinceAlphaMs:
      active?.alpha !== undefined ? Date.now() - active.alpha : null,
  })
}
// #endregion

/** Whether the developer `console.table` breakdown is printed. Marker
 * collection happens regardless — see `TTFT_REPORT_ENABLED`. */
export function ttftEnabled(): boolean {
  return TTFT_REPORT_ENABLED
}

export function ttftBegin(): void {
  // #region agent log
  ttftDebugLog('ttft-timing.ts:ttftBegin', 'alpha set', {
    wallMs: Date.now(),
  })
  // #endregion
  active = { alpha: Date.now() }
  reported = false
}

export function ttftMark(marker: TtftMarker): void {
  // #region agent log
  ttftDebugLog('ttft-timing.ts:ttftMark', marker, {
    wallMs: Date.now(),
    sinceAlphaMs:
      active?.alpha !== undefined ? Date.now() - active.alpha : null,
  })
  // #endregion
  if (!active) return
  active[marker] = Date.now()
}

export function ttftMarkFromRust(
  marker: 'zetaProxyIn' | 'zetaUpstreamHeaders' | 'etaFirstToken',
  epochMs: number
): void {
  // #region agent log
  ttftDebugLog('ttft-timing.ts:ttftMarkFromRust', marker, {
    epochMs,
    nowMs: Date.now(),
    sinceAlphaMs:
      active?.alpha !== undefined ? epochMs - active.alpha : null,
  })
  // #endregion
  if (!active) return
  active[marker] = epochMs
}

function delta(from?: number, to?: number): number | undefined {
  if (from === undefined || to === undefined) return undefined
  return Math.round(to - from)
}

/**
 * The stage breakdown for the current turn, ready to attach to
 * `chat_response_received`. Pure numbers in milliseconds — no PII. Fields are
 * omitted when either endpoint of a stage is missing (e.g. a provider that
 * never reaches the Rust proxy), so a partial breakdown is still useful.
 *
 * Does not clear the active timings: the analytics event is built at stream
 * finish, which is after `ttftReport` has already printed the dev table.
 */
export type TtftSnapshot = {
  /** Send click → first token. Wider than the transport's `ttft_ms`, which
   * starts at request construction: this one also covers attachment
   * processing and thread persistence, i.e. what the user actually waits. */
  ttft_e2e_ms?: number
  ttft_attachments_ms?: number
  ttft_tools_ms?: number
  ttft_create_model_ms?: number
  ttft_ipc_ms?: number
  ttft_proxy_ms?: number
  ttft_backend_ms?: number
  ttft_render_ms?: number
}

export function ttftSnapshot(): TtftSnapshot | null {
  if (!active) return null
  const t = active
  const firstToken = t.etaFirstToken ?? t.epsilonFirstChunk
  const snapshot: TtftSnapshot = {
    ttft_e2e_ms: delta(t.alpha, firstToken),
    ttft_attachments_ms: delta(t.alpha, t.beta),
    ttft_tools_ms: delta(t.beta ?? t.alpha, t.gammaEnd),
    ttft_create_model_ms: delta(t.gammaEnd, t.deltaEnd),
    ttft_ipc_ms: delta(t.deltaEnd, t.epsilonFirstChunk),
    ttft_proxy_ms: delta(t.epsilonFirstChunk, t.zetaUpstreamHeaders),
    ttft_backend_ms: delta(t.zetaUpstreamHeaders, t.etaFirstToken),
    ttft_render_ms: delta(firstToken, t.thetaFirstRender),
  }
  for (const key of Object.keys(snapshot) as (keyof TtftSnapshot)[]) {
    if (snapshot[key] === undefined) delete snapshot[key]
  }
  return snapshot
}

export function ttftReport(reason: string): void {
  if (!TTFT_REPORT_ENABLED || !active || reported) return
  const t = active
  const rows: Record<string, number | string> = {
    reason,
    'β−α attachments': delta(t.alpha, t.beta) ?? '—',
    'γ−β refreshTools': delta(t.beta, t.gammaEnd) ?? delta(t.alpha, t.gammaEnd) ?? '—',
    'δ−γ createModel': delta(t.gammaEnd, t.deltaEnd) ?? '—',
    'ε−δ first IPC chunk': delta(t.deltaEnd, t.epsilonFirstChunk) ?? '—',
    'ζ−ε proxy→upstream': delta(t.epsilonFirstChunk, t.zetaUpstreamHeaders) ?? '—',
    'η−ζ backend TTFT': delta(t.zetaUpstreamHeaders, t.etaFirstToken) ?? '—',
    'θ−α total visible': delta(t.alpha, t.thetaFirstRender) ?? '—',
    'θ−η UI after stream': delta(t.etaFirstToken, t.thetaFirstRender) ?? '—',
  }
  console.table(rows)
  // #region agent log
  ttftDebugLog('ttft-timing.ts:ttftReport', reason, {
    rows,
    rawMarkers: t as unknown as Record<string, unknown>,
  })
  // #endregion
  // Deliberately keeps `active` alive: `ttftSnapshot()` is read later, at
  // stream finish, to build the analytics event. `ttftBegin` resets it for the
  // next turn; `reported` keeps the table to one print per turn.
  reported = true
}
