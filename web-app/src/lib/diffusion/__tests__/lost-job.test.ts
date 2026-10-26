import { describe, expect, it } from 'vitest'

import {
  CoreInstanceTracker,
  coreReplaced,
  lostJobError,
  noCoreWillReturn,
} from '../lost-job'

describe('coreReplaced', () => {
  it.each([
    ['the same core', 'a', 'a', false],
    ['another core', 'a', 'b', true],
    ['a job never tied to a core', null, 'b', false],
    ['no core known now', 'a', null, false],
  ] as const)('%s', (_name, job, current, expected) => {
    expect(coreReplaced(job, current)).toBe(expected)
  })
})

describe('lostJobError', () => {
  it('says the engine stopped when the core was replaced, and that the job vanished otherwise', () => {
    expect(lostJobError('a', 'b').code).toBe('ENGINE_STOPPED')
    expect(lostJobError('a', 'a').code).toBe('JOB_NOT_FOUND')
    expect(lostJobError(null, 'a').code).toBe('JOB_NOT_FOUND')
  })
})

describe('noCoreWillReturn', () => {
  it('is true only when the app stopped starting cores', () => {
    expect(noCoreWillReturn({ code: 'CORE_START_FAILED', message: '' })).toBe(
      true
    )
    expect(noCoreWillReturn({ code: 'CORE_UNREACHABLE', message: '' })).toBe(
      false
    )
    expect(noCoreWillReturn(new Error('ipc'))).toBe(false)
    expect(noCoreWillReturn(null)).toBe(false)
  })
})

describe('CoreInstanceTracker', () => {
  it('ties a job to the core it was submitted to and notices a replacement', () => {
    const tracker = new CoreInstanceTracker()
    tracker.track('untracked')
    expect(tracker.instanceOf('untracked')).toBeNull()

    tracker.note('a')
    tracker.track('job-1')
    tracker.note(null)
    expect(tracker.current).toBe('a')
    expect(tracker.replaced('job-1')).toBe(false)

    tracker.note('b')
    expect(tracker.replaced('job-1')).toBe(true)
    expect(tracker.instanceOf('job-1')).toBe('a')

    tracker.forget('job-1')
    expect(tracker.replaced('job-1')).toBe(false)
    tracker.clear()
    expect(tracker.current).toBeNull()
  })
})
