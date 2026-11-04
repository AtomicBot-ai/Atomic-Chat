import { describe, expect, it } from 'vitest'

import {
  canBlameSettingsRestart,
  isDiagnosticText,
  summarizeTurnError,
  turnErrorKind,
  type TurnErrorContext,
} from '@/lib/turn-error-summary'
import { formatTransportError } from '@/lib/transport-error'
import {
  AUTHENTICATION_FAILED_TITLE,
  CONTEXT_OVERFLOW_MESSAGE,
  CONTEXT_OVERFLOW_TITLE,
  MODEL_ACCESS_DENIED_TITLE,
  OUT_OF_MEMORY_MESSAGE,
  OUT_OF_MEMORY_TITLE,
} from '@/utils/error'

/** Echoes the key and its options, so a test sees which text was picked. */
const t: TurnErrorContext['t'] = (key, options) =>
  options ? `${key} ${JSON.stringify(options)}` : key

const LOCAL = 'llamacpp-upstream'
const ENGINE_GONE = formatTransportError(
  'body_eof',
  'error decoding response body'
)

function summarize(error: unknown, context: Partial<TurnErrorContext> = {}) {
  return summarizeTurnError(error, { providerId: LOCAL, t, ...context })
}

describe('isDiagnosticText', () => {
  it.each([
    'Rate limit reached for requests. Try again in 20s.',
    'No endpoints found matching your data policy. Configure: https://openrouter.ai/settings/privacy',
    '[Open dashboard](https://example.com/dashboard) to accept the model terms.',
    'Line one.\nLine two.',
  ])('reads %j as a sentence', (text) => {
    expect(isDiagnosticText(text)).toBe(false)
  })

  it.each([
    ['a transport tag', ENGINE_GONE],
    ['a JSON envelope', '{"error":{"code":500,"message":"Compute error."}}'],
    [
      'an embedded envelope',
      'HTTP 500: {"error":{"message":"boom","type":"server_error"}}',
    ],
    ['a JSON array', '[{"message":"boom"}]'],
    [
      'a JS stack trace',
      'TypeError: x is undefined\n    at run (chat.ts:10:5)',
    ],
    [
      'a Python traceback',
      'Traceback (most recent call last):\n  File "server.py", line 3',
    ],
    ['many lines', 'one\ntwo\nthree'],
    ['very long text', 'word '.repeat(80)],
  ])('treats %s as a diagnostic', (_label, text) => {
    expect(isDiagnosticText(text)).toBe(true)
  })

  it('lets a message with links run longer before it counts as long', () => {
    const withLink = `${'Please accept the terms. '.repeat(14)}https://example.com/terms`
    expect(withLink.length).toBeGreaterThan(300)
    expect(isDiagnosticText(withLink)).toBe(false)
    expect(isDiagnosticText(withLink.repeat(3))).toBe(true)
  })
})

describe('summarizeTurnError', () => {
  it('keeps the context-overflow actions exactly as before (AC-05 untouched)', () => {
    const overflow = new Error(
      'the request exceeds the available context size.'
    )
    const grow = summarize(overflow)
    expect(grow).toMatchObject({
      kind: 'context',
      title: CONTEXT_OVERFLOW_TITLE,
      body: CONTEXT_OVERFLOW_MESSAGE,
      action: { type: 'increase-context' },
    })
    expect(grow.details).toBe(overflow.message)

    expect(summarize(overflow, { contextGrowthBlocked: true }).action).toEqual({
      type: 'shorten-history',
    })
  })

  it('sends a managed engine overflow to its settings, quoting it once', () => {
    const summary = summarize(
      new Error(
        "This model's maximum context length is 4096 tokens. [context_length_exceeded]"
      ),
      { providerId: 'tensorrt-llm', contextGrowthBlocked: true }
    )
    expect(summary.kind).toBe('managed-context')
    expect(summary.title).toBe(CONTEXT_OVERFLOW_TITLE)
    expect(summary.body).toContain('4096 tokens')
    expect(summary.details).toBeUndefined()
    expect(summary.action).toMatchObject({
      type: 'open-engine-settings',
      engineId: 'tensorrt-llm',
    })
  })

  it('classifies access, authentication and memory failures with Retry and the raw text under Details', () => {
    const access = summarize(
      new Error(
        'The model `gpt-x` does not exist or you do not have access to it.'
      ),
      { providerId: 'openai' }
    )
    expect(access).toMatchObject({
      kind: 'access',
      title: MODEL_ACCESS_DENIED_TITLE,
      action: { type: 'retry' },
    })
    expect(access.details).toContain('does not exist')

    const auth = summarize(new Error('401 Unauthorized'), {
      providerId: 'openai',
    })
    expect(auth).toMatchObject({
      kind: 'auth',
      title: AUTHENTICATION_FAILED_TITLE,
      details: '401 Unauthorized',
    })

    const oom = summarize(new Error('Compute error.'))
    expect(oom).toMatchObject({
      kind: 'oom',
      title: OUT_OF_MEMORY_TITLE,
      body: OUT_OF_MEMORY_MESSAGE,
      details: 'Compute error.',
      action: { type: 'retry' },
    })
  })

  it('says the local engine stopped and keeps the transport text under Details', () => {
    const summary = summarize(new Error(ENGINE_GONE))
    expect(summary).toEqual({
      kind: 'engine-gone',
      title: 'chat:turnRecovery.engineGoneTitle',
      body: 'chat:turnRecovery.engineGoneMessage',
      details: ENGINE_GONE,
      action: { type: 'retry' },
    })
    expect(
      summarize(new Error(ENGINE_GONE), { engineRecoveryFailed: true }).body
    ).toBe('chat:turnRecovery.engineRestartFailed')
  })

  it('does not call a remote failure an engine that stopped', () => {
    expect(
      summarize(new Error(ENGINE_GONE), { providerId: 'openai' }).kind
    ).toBe('generic')
  })

  it('says when a settings change restarted the model', () => {
    const summary = summarize(new Error(ENGINE_GONE), {
      settingsRestartModel: 'Qwen3.5 4B',
    })
    expect(summary).toEqual({
      kind: 'settings-restart',
      title: 'chat:turnRecovery.settingsRestartTitle',
      body: 'chat:turnRecovery.settingsRestartMessage {"model":"Qwen3.5 4B"}',
      details: ENGINE_GONE,
      action: { type: 'retry' },
    })
    expect(
      summarize(new Error(ENGINE_GONE), {
        settingsRestartModel: 'Qwen3.5 4B',
        engineRecoveryFailed: true,
      })
    ).toMatchObject({
      title: 'chat:turnRecovery.settingsRestartTitle',
      body: 'chat:turnRecovery.engineRestartFailed',
    })
  })

  it('never lets a settings restart hide a context or memory failure', () => {
    expect(
      summarize(new Error('Compute error.'), {
        settingsRestartModel: 'Qwen3.5 4B',
      }).kind
    ).toBe('oom')
    expect(
      summarize(new Error('the request exceeds the available context size.'), {
        settingsRestartModel: 'Qwen3.5 4B',
      }).kind
    ).toBe('context')
  })

  it('keeps a readable provider message as the body, links and all', () => {
    const message =
      'No endpoints found matching your data policy. Configure: https://openrouter.ai/settings/privacy'
    expect(summarize(new Error(message), { providerId: 'openrouter' })).toEqual(
      {
        kind: 'generic',
        title: 'chat:turnRecovery.genericTitle',
        body: message,
        action: { type: 'retry' },
      }
    )
  })

  it('puts a diagnostic behind Details with a readable sentence instead', () => {
    const envelope =
      'HTTP 500: {"error":{"code":500,"message":"slot unavailable","type":"server_error"}}'
    expect(summarize(new Error(envelope))).toEqual({
      kind: 'generic',
      title: 'chat:turnRecovery.genericTitle',
      body: 'chat:turnRecovery.genericMessage',
      details: envelope,
      action: { type: 'retry' },
    })
  })

  it('has a sentence for an error with no message, and no empty Details', () => {
    const summary = summarize(new Error(''))
    expect(summary.body).toBe('chat:turnRecovery.genericMessage')
    expect(summary.details).toBeUndefined()
  })
})

describe('canBlameSettingsRestart', () => {
  it('accepts an engine that went away, or an unclassified local failure', () => {
    expect(canBlameSettingsRestart(new Error(ENGINE_GONE), LOCAL)).toBe(true)
    expect(
      canBlameSettingsRestart(new Error('HTTP 503: Loading model'), LOCAL)
    ).toBe(true)
  })

  it('refuses remote providers and failures with their own guidance', () => {
    expect(canBlameSettingsRestart(new Error(ENGINE_GONE), 'openai')).toBe(
      false
    )
    expect(canBlameSettingsRestart(new Error('Compute error.'), LOCAL)).toBe(
      false
    )
    expect(
      canBlameSettingsRestart(
        new Error('the request exceeds the available context size.'),
        LOCAL
      )
    ).toBe(false)
    expect(turnErrorKind(new Error('401 Unauthorized'), LOCAL)).toBe('auth')
  })
})

// The card reads these keys in every language with the same placeholders.
const chatLocales = import.meta.glob<{ turnRecovery?: Record<string, string> }>(
  '../../locales/*/chat.json',
  { eager: true, import: 'default' }
)
const NEW_KEYS = [
  'retry',
  'details',
  'genericTitle',
  'genericMessage',
  'settingsRestartTitle',
  'settingsRestartMessage',
]
const placeholders = (text: string | undefined) =>
  [...(text ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

describe('turnRecovery card texts', () => {
  it('covers all 14 languages', () => {
    expect(Object.keys(chatLocales)).toHaveLength(14)
  })

  it.each(Object.entries(chatLocales))(
    '%s carries every key with the English placeholders',
    (_path, locale) => {
      const english = chatLocales['../../locales/en/chat.json'].turnRecovery
      for (const key of NEW_KEYS) {
        const text = locale.turnRecovery?.[key]
        expect(text, key).toBeTruthy()
        expect(placeholders(text), key).toEqual(placeholders(english?.[key]))
      }
    }
  )
})
