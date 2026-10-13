/**
 * Radium privacy gate.
 *
 * Deterministically redacts common secrets/PII before a request leaves the
 * device. Mappings are request-scoped and stay in renderer memory only.
 */

export interface PrivacyGateSettings {
  enabled: boolean
  customTerms: string[]
  rehydrateResponses: boolean
}

export interface PrivacyState {
  requestId: string
  map: Map<string, string>
  reverse: Map<string, string>
  counts: Record<string, number>
  customTerms: string[]
}

export interface PrivacyGateResult<T> {
  messages: T[]
  system?: string
  state: PrivacyState
  redactionCount: number
  counts: Record<string, number>
}

export const PRIVACY_GATE_STORAGE_KEY = 'privacy-gate'

export const DEFAULT_PRIVACY_GATE_SETTINGS: PrivacyGateSettings = {
  enabled: false,
  customTerms: [],
  rehydrateResponses: true,
}

type RuleContext = { offset: number; full: string }

type PrivacyRule = {
  type: string
  re: RegExp
  validate?: (match: string, context: RuleContext) => boolean
}

/**
 * Check the Luhn checksum of a string containing only decimal digits.
 */
export function luhn(digits: string): boolean {
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i])
    if (alternate) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    alternate = !alternate
  }
  return sum % 10 === 0
}

export const PRIVACY_RULES: PrivacyRule[] = [
  { type: 'AWSKEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    type: 'APIKEY',
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    type: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    type: 'EMAIL',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  {
    type: 'CARD',
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (match) => {
      const digits = match.replace(/\D/g, '')
      return digits.length >= 13 && digits.length <= 19 && luhn(digits)
    },
  },
  {
    type: 'SSN',
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    type: 'PHONE',
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]?\d{3,4}/g,
    validate: (match, context) => {
      const digits = match.replace(/\D/g, '')
      if (digits.length < 7 || digits.length > 15) return false
      const after = context.full.slice(context.offset + match.length)
      const before = context.full.slice(0, context.offset)
      if (/^[ .-]?\d/.test(after)) return false
      if (/\d[ .-]?$/.test(before)) return false
      return true
    },
  },
  {
    type: 'IPV4',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  },
  {
    type: 'POSTCODE_UK',
    re: /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/g,
  },
]

/**
 * Escape a custom term so it can be matched literally in a regular expression.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Create a short placeholder namespace using a UUID or a time/random fallback.
 */
function makeRequestId(): string {
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.randomUUID) {
    return cryptoObject.randomUUID().replace(/-/g, '').slice(0, 12)
  }
  const random = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}${random}`.slice(0, 12)
}

/**
 * Create request-local placeholder maps and counts, trimming and dropping empty terms.
 */
export function createPrivacyState(
  customTerms: string[] = [],
  requestId = makeRequestId()
): PrivacyState {
  return {
    requestId,
    map: new Map(),
    reverse: new Map(),
    counts: {},
    customTerms: customTerms.map((term) => term.trim()).filter(Boolean),
  }
}

/**
 * Reuse or allocate a placeholder by type and key, retaining the first original value.
 * Counts track distinct keys, not the number of occurrences.
 */
function tokenFor(
  type: string,
  original: string,
  state: PrivacyState,
  keyValue = original
): string {
  const key = `${type}:${keyValue}`
  const existing = state.map.get(key)
  if (existing) return existing

  state.counts[type] = (state.counts[type] ?? 0) + 1
  const token = `[RDM_${state.requestId}_${type}_${state.counts[type]}]`
  state.map.set(key, token)
  state.reverse.set(token, original)
  return token
}

/**
 * Replace built-in sensitive values and case-insensitive custom terms with placeholders.
 * Mutates the request maps and counts; leaves data and blob URLs unchanged.
 */
export function redactText(text: string, state: PrivacyState): string {
  if (!text) return text
  if (/^(?:data|blob):/i.test(text)) return text

  let output = text
  for (const rule of PRIVACY_RULES) {
    output = output.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const offset = Number(rest[rest.length - 2])
      const full = String(rest[rest.length - 1])
      if (rule.validate && !rule.validate(match, { offset, full })) return match
      return tokenFor(rule.type, match, state)
    })
  }

  for (const term of state.customTerms) {
    const regex = new RegExp(escapeRegex(term), 'gi')
    output = output.replace(regex, (match) =>
      tokenFor('TERM', match, state, match.toLowerCase())
    )
  }

  return output
}

/**
 * Copy nested message values while redacting strings with the shared request state.
 * Preserve media payloads and structural fields such as tool names and call IDs.
 */
function redactValue<T>(value: T, state: PrivacyState): T {
  if (typeof value === 'string') {
    return redactText(value, state) as T
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, state)) as T
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (
        key === 'data' ||
        key === 'image' ||
        key === 'mediaType' ||
        key === 'type' ||
        key === 'toolCallId' ||
        key === 'toolName'
      ) {
        output[key] = entry
      } else {
        output[key] = redactValue(entry, state)
      }
    }
    return output as T
  }
  return value
}

/**
 * Redact messages and optional system text using one fresh request state.
 * Return the redacted copies, restoration map, and counts of distinct replacements.
 */
export function applyPrivacyGate<T>({
  messages,
  system,
  customTerms = [],
  requestId,
}: {
  messages: T[]
  system?: string
  customTerms?: string[]
  requestId?: string
}): PrivacyGateResult<T> {
  const state = createPrivacyState(customTerms, requestId)
  const redactedMessages = redactValue(messages, state)
  const redactedSystem =
    typeof system === 'string' ? redactText(system, state) : system

  return {
    messages: redactedMessages,
    system: redactedSystem,
    state,
    redactionCount: state.map.size,
    counts: { ...state.counts },
  }
}

/**
 * Restore complete placeholders using their first recorded originals.
 * Unknown tokens and partial placeholders are left unchanged.
 */
export function rehydrateText(text: string, state: PrivacyState): string {
  if (!text || state.reverse.size === 0) return text
  let output = text
  for (const [token, original] of state.reverse.entries()) {
    output = output.split(token).join(original)
  }
  return output
}

/**
 * Count validated matches per built-in rule without redacting the input.
 * Rules are scanned independently; custom private terms are not included.
 */
export function scanSensitiveText(
  text: string
): Array<{ type: string; count: number }> {
  const full = String(text)
  const hits: Array<{ type: string; count: number }> = []

  for (const rule of PRIVACY_RULES) {
    const regex = new RegExp(rule.re.source, rule.re.flags)
    let count = 0
    for (const match of full.matchAll(regex)) {
      const value = match[0]
      const offset = match.index ?? 0
      if (rule.validate && !rule.validate(value, { offset, full })) continue
      count += 1
    }
    if (count > 0) hits.push({ type: rule.type, count })
  }

  return hits
}

/**
 * Read local settings, filtering non-string custom terms and applying defaults.
 * Return defaults when storage is unavailable, missing, or cannot be parsed.
 */
export function readPrivacyGateSettings(): PrivacyGateSettings {
  if (typeof window === 'undefined') return DEFAULT_PRIVACY_GATE_SETTINGS
  try {
    const raw = window.localStorage.getItem(PRIVACY_GATE_STORAGE_KEY)
    if (!raw) return DEFAULT_PRIVACY_GATE_SETTINGS
    const parsed = JSON.parse(raw) as Partial<PrivacyGateSettings>
    return {
      enabled: parsed.enabled === true,
      customTerms: Array.isArray(parsed.customTerms)
        ? parsed.customTerms.filter(
            (term): term is string => typeof term === 'string'
          )
        : [],
      rehydrateResponses: parsed.rehydrateResponses !== false,
    }
  } catch {
    return DEFAULT_PRIVACY_GATE_SETTINGS
  }
}

/**
 * Persist privacy settings in local storage; do nothing outside the browser.
 * Storage write errors propagate to the caller.
 */
export function writePrivacyGateSettings(settings: PrivacyGateSettings): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(
    PRIVACY_GATE_STORAGE_KEY,
    JSON.stringify(settings)
  )
}

/**
 * Rehydrates text that arrives in pieces.
 *
 * A streamed reply delivers a placeholder such as `[RDM_ab12_EMAIL_1]` split
 * across deltas (`[RDM_ab` + `12_EMAIL_1]`), so restoring each delta on its own
 * leaves the token visible. This keeps back only a tail that could still grow
 * into a known placeholder and releases everything else at once.
 */
export class StreamingRehydrator {
  private pending = ''

  constructor(private readonly state: PrivacyState) {}

  /** Add a delta; returns the text that is now safe to show. */
  push(delta: string): string {
    const text = this.pending + delta
    const holdFrom = this.partialTokenStart(text)
    this.pending = text.slice(holdFrom)
    return rehydrateText(text.slice(0, holdFrom), this.state)
  }

  /** Release whatever is held back (the part ended; it was not a token). */
  flush(): string {
    const rest = this.pending
    this.pending = ''
    return rehydrateText(rest, this.state)
  }

  /**
   * Index of the earliest `[` whose suffix is a proper prefix of a placeholder
   * this request created, or the text length when nothing needs holding.
   */
  private partialTokenStart(text: string): number {
    let longest = 0
    for (const token of this.state.reverse.keys()) {
      longest = Math.max(longest, token.length)
    }
    const searchFrom = Math.max(0, text.length - longest + 1)
    for (let index = searchFrom; index < text.length; index += 1) {
      if (text[index] !== '[') continue
      const tail = text.slice(index)
      for (const token of this.state.reverse.keys()) {
        if (tail.length < token.length && token.startsWith(tail)) return index
      }
    }
    return text.length
  }
}

type StreamChunk = { type: string } & Record<string, unknown>

/** Which streamed field carries a delta, keyed by chunk type. */
const DELTA_FIELDS: Record<
  string,
  { idField: string; deltaField: string; endTypes: string[] }
> = {
  'text-delta': { idField: 'id', deltaField: 'delta', endTypes: ['text-end'] },
  'reasoning-delta': {
    idField: 'id',
    deltaField: 'delta',
    endTypes: ['reasoning-end'],
  },
  'tool-input-delta': {
    idField: 'toolCallId',
    deltaField: 'inputTextDelta',
    endTypes: ['tool-input-available', 'tool-input-error'],
  },
}

function rehydrateValue(value: unknown, state: PrivacyState): unknown {
  if (typeof value === 'string') return rehydrateText(value, state)
  if (Array.isArray(value)) {
    return value.map((entry) => rehydrateValue(entry, state))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        rehydrateValue(entry, state),
      ])
    )
  }
  return value
}

/**
 * Restores request-scoped placeholders in a UI message stream before it
 * reaches the transcript or local tool execution.
 *
 * Deltas are buffered per part so a placeholder split across chunks is still
 * restored; the held-back tail is released just before the part's end chunk
 * (or when the stream ends), so no text is lost or reordered. Whole-value
 * chunks (tool input, tool output, metadata) are restored in one go.
 */
export function rehydrateUIMessageStream<T extends { type: string }>(
  stream: ReadableStream<T>,
  state: PrivacyState
): ReadableStream<T> {
  const open = new Map<
    string,
    { rehydrator: StreamingRehydrator; chunk: StreamChunk; deltaField: string }
  >()
  const keyFor = (kind: string, id: unknown) => `${kind}:${String(id)}`

  const release = (
    key: string,
    controller: TransformStreamDefaultController<T>
  ) => {
    const part = open.get(key)
    if (!part) return
    open.delete(key)
    const rest = part.rehydrator.flush()
    if (rest) {
      controller.enqueue({ ...part.chunk, [part.deltaField]: rest } as T)
    }
  }

  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(input, controller) {
        const chunk = input as unknown as StreamChunk
        const delta = DELTA_FIELDS[chunk.type]
        if (delta) {
          const key = keyFor(delta.deltaField, chunk[delta.idField])
          let part = open.get(key)
          if (!part) {
            part = {
              rehydrator: new StreamingRehydrator(state),
              chunk,
              deltaField: delta.deltaField,
            }
            open.set(key, part)
          }
          part.chunk = chunk
          const text = part.rehydrator.push(String(chunk[delta.deltaField]))
          if (text)
            controller.enqueue({ ...chunk, [delta.deltaField]: text } as T)
          return
        }

        for (const [type, fields] of Object.entries(DELTA_FIELDS)) {
          if (fields.endTypes.includes(chunk.type)) {
            release(
              keyFor(DELTA_FIELDS[type].deltaField, chunk[fields.idField]),
              controller
            )
          }
        }
        if (
          chunk.type === 'finish' ||
          chunk.type === 'error' ||
          chunk.type === 'abort'
        ) {
          for (const key of [...open.keys()]) release(key, controller)
        }
        controller.enqueue(rehydrateValue(chunk, state) as T)
      },
      flush(controller) {
        for (const key of [...open.keys()]) release(key, controller)
      },
    })
  )
}
