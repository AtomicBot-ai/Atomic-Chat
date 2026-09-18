import { describe, expect, it } from 'vitest'

import en from '@/locales/en/images.json'
import type { NativeDiffusionErrorCode } from '@/services/diffusion/types'
import {
  DIFFUSION_ERROR_CODES,
  describeDiffusionError,
  errorActionLabelKey,
  toDiffusionError,
} from '../errors'

/** Every code the contract declares, spelled out so a new one fails here. */
const CONTRACT_CODES: NativeDiffusionErrorCode[] = [
  'ENGINE_MISSING',
  'ENGINE_INSTALL_FAILED',
  'ENGINE_CRASHED',
  'MODEL_MISSING',
  'SIDE_FILE_MISSING',
  'MODEL_LOAD_FAILED',
  'MODEL_INCOMPATIBLE',
  'MODEL_NOT_LOADED',
  'OUT_OF_MEMORY',
  'UNSUPPORTED_BACKEND',
  'UNSUPPORTED_WORKFLOW',
  'INVALID_DIMENSIONS',
  'INVALID_REQUEST',
  'JOB_BUSY',
  'JOB_NOT_FOUND',
  'QUEUE_FULL',
  'CANCELLED',
  'DISK_FULL',
  'BACKEND_IN_USE',
  'NOT_CONFIGURED',
  'INTERNAL',
]

describe('describeDiffusionError', () => {
  it('covers every code in the contract', () => {
    expect([...DIFFUSION_ERROR_CODES].sort()).toEqual([...CONTRACT_CODES].sort())
  })

  it.each(CONTRACT_CODES)('has English copy for %s', (code) => {
    const described = describeDiffusionError(code)
    const bundle = en.errors as Record<string, { title: string; body: string }>
    expect(described.titleKey).toBe(`images:errors.${code}.title`)
    expect(bundle[code]?.title.length).toBeGreaterThan(0)
    expect(bundle[code]?.body.length).toBeGreaterThan(0)
  })

  it('routes the actionable codes to the action that fixes them', () => {
    expect(describeDiffusionError('OUT_OF_MEMORY')).toMatchObject({
      action: 'reduceSize',
      secondaryAction: 'pickSmallerQuant',
    })
    expect(describeDiffusionError('ENGINE_MISSING').action).toBe('install')
    expect(describeDiffusionError('MODEL_MISSING').action).toBe('download')
    expect(describeDiffusionError('SIDE_FILE_MISSING').action).toBe('download')
    expect(describeDiffusionError('UNSUPPORTED_BACKEND').action).toBe(
      'openSettings'
    )
    expect(describeDiffusionError('DISK_FULL').action).toBe('openOutputFolder')
  })

  it('offers nothing for a cancellation', () => {
    expect(describeDiffusionError('CANCELLED')).toMatchObject({
      action: null,
      secondaryAction: null,
    })
  })

  it('has a label for every action it can route to', () => {
    const labels = en.errors.actions as Record<string, string>
    for (const code of CONTRACT_CODES) {
      const { action, secondaryAction } = describeDiffusionError(code)
      for (const candidate of [action, secondaryAction]) {
        if (!candidate) continue
        expect(errorActionLabelKey(candidate)).toBe(
          `images:errors.actions.${candidate}`
        )
        expect(labels[candidate]?.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('toDiffusionError', () => {
  it('keeps a plugin error as it is', () => {
    expect(
      toDiffusionError({ code: 'DISK_FULL', message: 'no space', details: 'x' })
    ).toEqual({ code: 'DISK_FULL', message: 'no space', details: 'x' })
  })

  it('wraps an unknown code or a plain Error as INTERNAL', () => {
    expect(toDiffusionError({ code: 'WHATEVER', message: 'm' })).toMatchObject({
      code: 'INTERNAL',
    })
    expect(toDiffusionError(new Error('boom'))).toEqual({
      code: 'INTERNAL',
      message: 'boom',
    })
    expect(toDiffusionError(undefined).message).toBe('')
  })

  // What the relay and the core's HTTP layer reject with besides the
  // diffusion codes: a plain object, never an Error.
  it.each([
    [
      'an unreachable core',
      { code: 'CORE_UNREACHABLE', message: 'The core is not reachable.', details: 'connection refused' },
      { code: 'INTERNAL', message: 'The core is not reachable.', details: 'CORE_UNREACHABLE: connection refused' },
    ],
    [
      'a core that is not running',
      { code: 'CORE_NOT_RUNNING', message: 'The app is starting up or shutting down.' },
      { code: 'INTERNAL', message: 'The app is starting up or shutting down.', details: 'CORE_NOT_RUNNING' },
    ],
    [
      'another core version',
      { code: 'CORE_VERSION_MISMATCH', message: 'A different Atomic Chat core is already running.', details: 'pid 123' },
      { code: 'INTERNAL', message: 'A different Atomic Chat core is already running.', details: 'CORE_VERSION_MISMATCH: pid 123' },
    ],
    [
      'a refused body',
      { code: 'INVALID_ARGUMENT', message: 'The request body is not valid JSON.' },
      { code: 'INTERNAL', message: 'The request body is not valid JSON.', details: 'INVALID_ARGUMENT' },
    ],
    [
      'an HTTP status',
      { code: 'HTTP_502', message: 'Bad gateway', details: 'upstream closed' },
      { code: 'INTERNAL', message: 'Bad gateway', details: 'HTTP_502: upstream closed' },
    ],
    [
      "the core's raw throw",
      { code: 'INTERNAL_ERROR', message: 'Something broke.' },
      { code: 'INTERNAL', message: 'Something broke.', details: 'INTERNAL_ERROR' },
    ],
    [
      'a code that is only an Object.prototype key',
      { code: 'toString', message: 'm' },
      { code: 'INTERNAL', message: 'm', details: 'toString' },
    ],
    [
      'an object without a code',
      { message: 'no code', details: 'd' },
      { code: 'INTERNAL', message: 'no code', details: 'd' },
    ],
    ['an empty object', {}, { code: 'INTERNAL', message: '' }],
    ['a string', 'plain failure', { code: 'INTERNAL', message: 'plain failure' }],
    ['null', null, { code: 'INTERNAL', message: '' }],
  ])('keeps the message of %s and routes it as INTERNAL', (_label, rejection, expected) => {
    const described = toDiffusionError(rejection)
    expect(described).toEqual(expected)
    expect(described.message).not.toContain('[object Object]')
  })
})
