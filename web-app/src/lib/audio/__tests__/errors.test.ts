import { describe, expect, it } from 'vitest'

import en from '@/locales/en/audios.json'
import ru from '@/locales/ru/audios.json'
import { AUDIO_ERROR_CODES } from '@/services/audio/types'

import {
  describeAudioError,
  isMissingAudioRoute,
  toAudioError,
} from '../errors'
import { missingRoute } from './audio-fixtures'

describe('describeAudioError', () => {
  it.each(AUDIO_ERROR_CODES)(
    'gives %s plain words in both languages',
    (code) => {
      expect(describeAudioError(code).titleKey).toBe(
        `audios:errors.${code}.title`
      )
      expect(en.errors[code].title).toBeTruthy()
      expect(en.errors[code].body).toBeTruthy()
      expect(ru.errors[code].title).toBeTruthy()
      expect(ru.errors[code].body).toBeTruthy()
    }
  )

  it('offers what fixes the failure', () => {
    expect(describeAudioError('ENGINE_MISSING').action).toBe('install')
    expect(describeAudioError('MODEL_MISSING').action).toBe('chooseModel')
    expect(describeAudioError('OUT_OF_MEMORY').action).toBe('chooseModel')
    expect(describeAudioError('JOB_BUSY').action).toBe('retry')
    expect(describeAudioError('UNSUPPORTED_MODE').action).toBe('retry')
    expect(describeAudioError('REQUEST_REJECTED').action).toBeNull()
  })

  it('shows the engine’s words only for what it refused', () => {
    expect(describeAudioError('REQUEST_REJECTED').showsDetails).toBe(true)
    expect(describeAudioError('INTERNAL').showsDetails).toBe(false)
  })
})

describe('toAudioError', () => {
  it('keeps an audio code with its message and details', () => {
    expect(
      toAudioError({ code: 'JOB_BUSY', message: 'Busy', details: 'job-1' })
    ).toEqual({ code: 'JOB_BUSY', message: 'Busy', details: 'job-1' })
  })

  it('reads the relay’s own codes as INTERNAL, the code kept in the details', () => {
    expect(
      toAudioError({ code: 'CORE_UNREACHABLE', message: 'No core' })
    ).toEqual({
      code: 'INTERNAL',
      message: 'No core',
      details: 'CORE_UNREACHABLE',
    })
    expect(
      toAudioError({ code: 'HTTP_502', message: 'Bad', details: 'body' })
    ).toEqual({ code: 'INTERNAL', message: 'Bad', details: 'HTTP_502: body' })
  })

  it('turns anything else into a message', () => {
    expect(toAudioError('boom')).toEqual({ code: 'INTERNAL', message: 'boom' })
    expect(toAudioError(new Error('boom'))).toEqual({
      code: 'INTERNAL',
      message: 'boom',
    })
  })
})

describe('isMissingAudioRoute', () => {
  it('recognises a core that has no audio routes', () => {
    expect(isMissingAudioRoute(missingRoute())).toBe(true)
    expect(
      isMissingAudioRoute({ code: 'HTTP_404', message: 'The core…' })
    ).toBe(true)
  })

  it('leaves a refused request and an absent core alone', () => {
    expect(
      isMissingAudioRoute({ code: 'INVALID_ARGUMENT', message: 'Bad field' })
    ).toBe(false)
    expect(
      isMissingAudioRoute({ code: 'CORE_UNREACHABLE', message: 'No core' })
    ).toBe(false)
    expect(isMissingAudioRoute(null)).toBe(false)
  })
})
