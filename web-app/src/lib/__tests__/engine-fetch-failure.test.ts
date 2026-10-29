import { describe, expect, it } from 'vitest'

import {
  describeEngineFetchFailure,
  engineFetchFailureText,
  hostCheckHeadlineKey,
} from '../engine-fetch-failure'

const MANIFEST =
  'sd.cpp manifest from https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/sdcpp-manifest.json'
const HOST = 'raw.githubusercontent.com'

// The texts are what the core (Bun 1.3 fetch) reports for each failure.
describe('describeEngineFetchFailure', () => {
  it('reads the core timeout with its length', () => {
    expect(
      describeEngineFetchFailure(`${MANIFEST}: timed out after 8000ms`)
    ).toEqual({ kind: 'timeout', host: HOST, seconds: 8 })
  })

  it('reads a DNS failure, a refused connection and a dead proxy as unreachable', () => {
    expect(
      describeEngineFetchFailure(
        `${MANIFEST}: Unable to connect. Is the computer able to access the url?`
      )
    ).toEqual({ kind: 'unreachable', host: HOST })
    expect(describeEngineFetchFailure('fetch failed')).toEqual({
      kind: 'unreachable',
      host: null,
    })
  })

  it('reads an HTTP status, from the manifest read and from the downloader', () => {
    expect(describeEngineFetchFailure(`${MANIFEST}: HTTP 429`)).toEqual({
      kind: 'http',
      host: HOST,
      status: 429,
    })
    expect(
      describeEngineFetchFailure('Failed to get file size: HTTP status 404')
    ).toEqual({ kind: 'http', host: null, status: 404 })
  })

  it('reads certificate failures', () => {
    for (const message of [
      'self signed certificate',
      'certificate has expired',
      'ERR_TLS_CERT_ALTNAME_INVALID fetching "https://wrong.host.badssl.com/".',
      'unable to get local issuer certificate',
    ]) {
      expect(describeEngineFetchFailure(`${MANIFEST}: ${message}`)?.kind).toBe(
        'certificate'
      )
    }
  })

  it('reads a page that is not the manifest as invalid', () => {
    expect(
      describeEngineFetchFailure(
        `${MANIFEST}: JSON Parse error: Unrecognized token '<'`
      )
    ).toEqual({ kind: 'invalid', host: HOST })
    expect(
      describeEngineFetchFailure(
        `${MANIFEST}: the sd.cpp manifest has no valid tag_name (undefined)`
      )?.kind
    ).toBe('invalid')
  })

  it('names no failure for other errors', () => {
    expect(describeEngineFetchFailure('No space left on device.')).toBeNull()
    expect(describeEngineFetchFailure('')).toBeNull()
    expect(describeEngineFetchFailure(null)).toBeNull()
  })
})

describe('engineFetchFailureText', () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key

  it('fills in the host and the seconds', () => {
    expect(
      engineFetchFailureText(`${MANIFEST}: timed out after 8000ms`, t)
    ).toBe(
      `images:setup.engine.reason.timeoutSeconds ${JSON.stringify({ host: HOST, seconds: 8 })}`
    )
  })

  it('says "the server" when the text names no URL', () => {
    expect(engineFetchFailureText('HTTP status 503', t)).toBe(
      `images:setup.engine.reason.http ${JSON.stringify({
        host: 'images:setup.engine.reason.server',
        status: 503,
      })}`
    )
  })

  it('is null for an error it does not know', () => {
    expect(engineFetchFailureText('No space left.', t)).toBeNull()
  })
})

describe('hostCheckHeadlineKey', () => {
  it('tells a failed check from a host without a build', () => {
    expect(hostCheckHeadlineKey('manifest')).toBe('images:setup.engine.offline')
    expect(hostCheckHeadlineKey('core')).toBe('images:setup.engine.checkFailed')
    expect(hostCheckHeadlineKey(null)).toBe('images:setup.engine.unsupported')
  })
})
