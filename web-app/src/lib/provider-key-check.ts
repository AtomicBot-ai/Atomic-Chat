/**
 * Checking a provider's API key before calling it connected, and noting what
 * the provider says about it later.
 *
 * The check is the provider's registry `key_check` (OpenRouter's `/key`,
 * Hugging Face's `whoami-v2`) where it has one, and otherwise its own model
 * listing (`checkProviderEndpoint`), asked with the key being saved. Its
 * answer sorts three ways:
 *
 *  - it answered 2xx (for a model listing, with models) → the key works;
 *  - it said the key is invalid — a 401 that is not about missing
 *    permissions, or an invalid-key body such as the 400 `API_KEY_INVALID`
 *    Gemini sends → the key is not saved unless the user insists, and is told
 *    why;
 *  - anything else (no network, a timeout, a 403, a 401 for a key without
 *    "Models: read", a 404, a 5xx) → the key is saved, but as "configured,
 *    not verified" with the reason. A restricted key may be refused the model
 *    list and still chat.
 *
 * A provider whose model listing is public and that has no `key_check`
 * (AIML API, Eden AI) answers whatever the key, so for those a bad key still
 * passes here; the first chat the provider refuses marks it through
 * {@link noteProviderRequestError}, and
 * the first chat it answers clears that through
 * {@link noteProviderRequestSucceeded}.
 */

import { ownLocalApiServerUrl } from '@/lib/local-api-self-reference'
import type { ServiceHub } from '@/services'
import type { EndpointCheckResult } from '@/services/providers/types'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'
import {
  isLocalProvider,
  isSubscriptionProvider,
} from '@/utils/registerRemoteProvider'

export type KeyCheckOutcome =
  | { kind: 'verified' }
  /**
   * Not saved: the provider said the key is invalid (the user may still save
   * it anyway), or the address is the app's own server.
   */
  | {
      kind: 'refused'
      reason: 'key' | 'ownServer'
      message: string
      /** The Local API Server's URL, for `reason: 'ownServer'`. */
      serverUrl?: string
    }
  /** Save, but say it could not be checked. */
  | { kind: 'unverified'; message: string }

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Bodies that say the key itself is not valid. Gemini answers a bad key with
 * 400 `API_KEY_INVALID` rather than 401.
 */
const INVALID_KEY_BODY =
  /api[_ ]?key[_ ]?invalid|api key not valid|invalid[_ ]api[_ -]?key|incorrect api key/i

/**
 * A 401 about what a valid key may do, not about the key: OpenAI answers a
 * restricted key without "Models: read" with "insufficient permissions …
 * Missing scopes".
 */
const MISSING_PERMISSION_BODY =
  /insufficient[_ ]permissions?|missing[_ ]scopes?|insufficient[_ ]scopes?/i

/**
 * The Local API Server's own 401, sent when the app's request does not carry
 * the server's key (`proxy.rs`). It says nothing about the provider's key.
 */
const LOCAL_PROXY_AUTH_BODY = /invalid or missing authorization token/i

/** Does an answer with this status and body say the key is invalid? */
function saysKeyIsInvalid(status: number | undefined, body: string): boolean {
  if (status === 401) {
    return (
      !MISSING_PERMISSION_BODY.test(body) && !LOCAL_PROXY_AUTH_BODY.test(body)
    )
  }
  // Gemini's 400, or an error envelope some gateways serve with a 200.
  if (status === 400 || status === undefined) {
    return INVALID_KEY_BODY.test(body)
  }
  return false
}

/** The provider's own words in an error body: `error.message`, or the text. */
function providerReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    const error = asRecord(asRecord(first)?.error) ?? asRecord(first)
    if (typeof error?.message === 'string' && error.message.trim()) {
      return error.message.trim()
    }
  } catch {
    // Not JSON: the body is the reason.
  }
  return body.trim().slice(0, 300)
}

/** Sort one model-listing check into the three outcomes above. */
export function classifyKeyCheck(
  result: EndpointCheckResult | undefined
): KeyCheckOutcome {
  if (!result) {
    return { kind: 'unverified', message: 'The provider could not be checked.' }
  }
  if (result.ok) return { kind: 'verified' }
  const message = result.message ?? ''
  const body = result.responseBody ?? message
  if (saysKeyIsInvalid(result.httpStatus, body)) {
    return { kind: 'refused', reason: 'key', message }
  }
  // A 401/403 that did not say the key is invalid: the generic "Authentication
  // failed" line would claim it did, so the provider's own words go instead.
  const status = result.httpStatus
  const reason =
    (status === 401 || status === 403) && result.responseBody
      ? providerReason(result.responseBody)
      : ''
  return {
    kind: 'unverified',
    message: reason ? `HTTP ${status}: ${reason}` : message,
  }
}

/** `b` is `a`, or one of them is a subdomain of the other. */
const relatedHosts = (a: string, b: string) =>
  a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)

/**
 * Where the provider's registry `key_check` asks, for the base URL it has
 * now; `undefined` when it has none, or none usable:
 *
 *  - `path` joins onto the base URL, wherever the user pointed it;
 *  - `url` is used only while the base URL is on the same host or shares its
 *    parent domain (`router.huggingface.co` → `huggingface.co`): a key typed
 *    for a server the user moved the provider to is never sent elsewhere;
 *  - only HTTPS, only GET.
 */
export function keyCheckUrl(
  provider: Pick<ModelProvider, 'base_url' | 'key_check'>
): string | undefined {
  const check = provider.key_check
  if (!check || (check.method !== undefined && check.method !== 'GET')) {
    return undefined
  }
  const baseUrl = (provider.base_url ?? '').trim().replace(/\/+$/, '')
  if (!baseUrl) return undefined
  if (typeof check.path === 'string') {
    return /^\/[^/]/.test(check.path) ? `${baseUrl}${check.path}` : undefined
  }
  if (typeof check.url !== 'string') return undefined
  try {
    const target = new URL(check.url)
    const base = new URL(baseUrl)
    if (target.protocol !== 'https:') return undefined
    return relatedHosts(target.hostname, base.hostname)
      ? target.toString()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask `provider` about `apiKey`, without saving anything: at its registry
 * `key_check` when it has a usable one, otherwise its model listing. Never
 * throws: a check that cannot run is an `unverified` outcome.
 */
export async function checkProviderKey(
  provider: ModelProvider,
  apiKey: string,
  serviceHub: Pick<ServiceHub, 'providers'>
): Promise<KeyCheckOutcome> {
  const serverUrl = ownLocalApiServerUrl(provider.base_url ?? '')
  if (serverUrl) {
    return {
      kind: 'refused',
      reason: 'ownServer',
      serverUrl,
      message: `This address is Atomic Chat's own Local API Server (${serverUrl}).`,
    }
  }
  try {
    const candidate = { ...provider, api_key: apiKey }
    const keyUrl = keyCheckUrl(provider)
    const result = keyUrl
      ? await serviceHub.providers().checkProviderKeyUrl(candidate, keyUrl)
      : await serviceHub.providers().checkProviderEndpoint(candidate)
    return classifyKeyCheck(result)
  } catch (error) {
    return {
      kind: 'unverified',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Record what a check said about the key now saved on `providerName`: an
 * `unverified` outcome is remembered, a verified one clears whatever was there.
 */
export function recordKeyCheck(
  providerName: string,
  apiKey: string,
  outcome: KeyCheckOutcome
): void {
  const store = useProviderKeyStatusStore.getState()
  if (outcome.kind === 'unverified' && apiKey.trim()) {
    store.setStatus(providerName, apiKey, 'unverified', outcome.message)
  } else if (outcome.kind === 'verified') {
    store.clear(providerName)
  }
}

/**
 * What saving a refused key anyway amounts to: "configured, not verified",
 * with the provider's reason, until a chat or a check says otherwise.
 */
export const savedAnyway = (reason: string): KeyCheckOutcome => ({
  kind: 'unverified',
  message: reason,
})

type CloudProvider = Pick<ModelProvider, 'provider' | 'api_key' | 'persist'>

/** A provider whose own API key is what a chat request authenticates with. */
const keyedCloudProvider = (provider: CloudProvider | undefined) =>
  Boolean(
    provider &&
      !isLocalProvider(provider.provider) &&
      provider.persist !== true &&
      !isSubscriptionProvider(provider.provider) &&
      provider.api_key?.trim()
  )

/**
 * The HTTP status and body of a failed request, read from the fields the AI
 * SDK's `APICallError` carries (`statusCode`, `responseBody`), also when it
 * is wrapped (`lastError`, `cause`). Text that merely contains "401" is not a
 * status.
 */
function httpFailureOf(
  error: unknown,
  depth = 0
): { status: number; body: string } | undefined {
  const record = asRecord(error)
  if (!record || depth > 3) return undefined
  const status = record.statusCode ?? record.status
  if (typeof status === 'number') {
    const body =
      typeof record.responseBody === 'string'
        ? record.responseBody
        : typeof record.message === 'string'
          ? record.message
          : ''
    return { status, body }
  }
  return (
    httpFailureOf(record.lastError, depth + 1) ??
    httpFailureOf(record.cause, depth + 1)
  )
}

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * A chat request to `provider` failed with `error`. Only the provider saying
 * the key is invalid marks it `rejected`: a 401 from upstream that is not
 * about permissions, or Gemini's invalid-key 400. A 403 (moderation, region,
 * a model the key may not use) and the Local API Server's own 401 leave the
 * key alone.
 */
export function noteProviderRequestError(
  provider: CloudProvider | undefined,
  error: unknown
): void {
  if (!provider || !keyedCloudProvider(provider)) return
  const failure = httpFailureOf(error)
  if (!failure || failure.status === 403) return
  const invalid =
    failure.status === 401
      ? saysKeyIsInvalid(401, failure.body)
      : failure.status === 400 && INVALID_KEY_BODY.test(failure.body)
  if (!invalid) return
  useProviderKeyStatusStore
    .getState()
    .setStatus(
      provider.provider,
      provider.api_key ?? '',
      'rejected',
      errorText(error)
    )
}

/**
 * A chat request to `provider` was answered in full: whatever was recorded
 * about its key — unverified when saved, rejected by an earlier chat — no
 * longer holds.
 */
export function noteProviderRequestSucceeded(
  provider: CloudProvider | undefined
): void {
  if (!provider || !keyedCloudProvider(provider)) return
  const store = useProviderKeyStatusStore.getState()
  if (keyStatusFor(provider, store.statuses)) store.clear(provider.provider)
}
