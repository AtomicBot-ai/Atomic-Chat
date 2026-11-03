/**
 * Why the core could not fetch an engine manifest or build, read from the
 * error text it reports (`manifest_error`, an install rejection's message and
 * details). The core runs on Bun, whose fetch says "Unable to connect" alike
 * for a DNS failure, a refused connection and a dead proxy, so those are one
 * kind here.
 */
export type EngineFetchFailureKind =
  | 'timeout'
  | 'http'
  | 'certificate'
  | 'unreachable'
  | 'invalid'

export type EngineFetchFailure = {
  kind: EngineFetchFailureKind
  /** The host the core tried, when the text names a URL. */
  host: string | null
  /** `http`: the status the server answered with. */
  status?: number
  /** `timeout`: how long the core waited, in seconds. */
  seconds?: number
}

const URL_HOST_RE = /https?:\/\/([^/\s:'"`]+)/i
const TIMED_OUT_RE = /timed out after (\d+)\s*ms/i
const TIMEOUT_RE = /\b(timeout|timed out|ETIMEDOUT)\b/i
const HTTP_STATUS_RE = /\bHTTP(?: status)? (\d{3})\b/i
const CERTIFICATE_RE =
  /certificate|\bCERT_|_CERT_|\bSSL\b|\bTLS\b|UNABLE_TO_VERIFY|self[- ]signed/i
const UNREACHABLE_RE =
  /Unable to connect|ConnectionRefused|ConnectionClosed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|fetch failed|network/i
const INVALID_RE =
  /JSON Parse error|Unexpected token|not valid JSON|is not an object|has no valid/i

/** The failure the text describes, or `null` when it names none of these. */
export function describeEngineFetchFailure(
  text: string | null | undefined
): EngineFetchFailure | null {
  if (!text) return null
  const host = URL_HOST_RE.exec(text)?.[1] ?? null
  const timedOut = TIMED_OUT_RE.exec(text)
  if (timedOut)
    return {
      kind: 'timeout',
      host,
      seconds: Math.round(Number(timedOut[1]) / 1000),
    }
  if (TIMEOUT_RE.test(text)) return { kind: 'timeout', host }
  const status = HTTP_STATUS_RE.exec(text)
  if (status) return { kind: 'http', host, status: Number(status[1]) }
  if (CERTIFICATE_RE.test(text)) return { kind: 'certificate', host }
  if (UNREACHABLE_RE.test(text)) return { kind: 'unreachable', host }
  if (INVALID_RE.test(text)) return { kind: 'invalid', host }
  return null
}

type Translate = (key: string, values?: Record<string, unknown>) => string

/**
 * The headline when the host check gave no engine build: a failed read of
 * the manifest, no answer from the core, or a host the manifest has no build for.
 */
export function hostCheckHeadlineKey(
  checkFailed: 'manifest' | 'core' | null
): string {
  if (checkFailed === 'manifest') return 'images:setup.engine.offline'
  if (checkFailed === 'core') return 'images:setup.engine.checkFailed'
  return 'images:setup.engine.unsupported'
}

/**
 * The plain-words reason for an engine fetch failure (copy under
 * `images:setup.engine.reason`), or `null` when the text names no known one.
 */
export function engineFetchFailureText(
  text: string | null | undefined,
  t: Translate
): string | null {
  const failure = describeEngineFetchFailure(text)
  if (!failure) return null
  const key =
    failure.kind === 'timeout' && failure.seconds !== undefined
      ? 'images:setup.engine.reason.timeoutSeconds'
      : `images:setup.engine.reason.${failure.kind}`
  return t(key, {
    host: failure.host ?? t('images:setup.engine.reason.server'),
    status: failure.status,
    seconds: failure.seconds,
  })
}
