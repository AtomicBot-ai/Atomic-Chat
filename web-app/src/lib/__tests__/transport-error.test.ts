import { describe, expect, it } from 'vitest'
import {
  formatTransportError,
  isEngineGoneKind,
  parseOsErrorCode,
  parseTransportKind,
} from '../transport-error'

describe('transport-error', () => {
  it('reads the kind from strings, errors and message objects', () => {
    const msg = formatTransportError(
      'connect_refused',
      'Request failed: error sending request: Подключение не установлено (os error 10061)'
    )
    expect(parseTransportKind(msg)).toBe('connect_refused')
    expect(parseTransportKind(new Error(msg))).toBe('connect_refused')
    expect(parseTransportKind({ message: `Stream error: x ${'[transport:body_eof]'}` })).toBe('body_eof')
  })

  it('ignores untagged and unknown kinds', () => {
    expect(parseTransportKind('Request failed: connection refused')).toBeUndefined()
    expect(parseTransportKind('[transport:wat] x')).toBeUndefined()
    expect(parseTransportKind(undefined)).toBeUndefined()
  })

  it('marks the kinds that mean the engine is gone', () => {
    expect(isEngineGoneKind('connect_refused')).toBe(true)
    expect(isEngineGoneKind('body_eof')).toBe(true)
    expect(isEngineGoneKind('idle_timeout')).toBe(false)
    expect(isEngineGoneKind(undefined)).toBe(false)
  })

  it('parses the OS error code', () => {
    expect(parseOsErrorCode('x (os error 10061)')).toBe(10061)
    expect(parseOsErrorCode('no code')).toBeUndefined()
  })
})
