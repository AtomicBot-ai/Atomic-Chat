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
})
