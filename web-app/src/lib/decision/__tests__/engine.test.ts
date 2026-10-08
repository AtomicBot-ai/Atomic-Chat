import { describe, expect, it } from 'vitest'

import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'

import {
  DECISION_ENGINE_UI,
  decisionEngineReadiness,
  decisionErrorAction,
  isUncheckedEngineError,
  upstreamBuildOf,
  upstreamEngineReadiness,
} from '../engine'

const byId = (id: string) =>
  getBaselineDecisionCatalog().models.find((model) => model.id === id)!

describe('upstreamBuildOf', () => {
  it('reads a stock llama.cpp tag, with or without its backend', () => {
    expect(upstreamBuildOf('b11436/macos-arm64')).toBe(11436)
    expect(upstreamBuildOf('b11370')).toBe(11370)
  })

  it('reads nothing from a fork tag, a placeholder or no setting', () => {
    expect(upstreamBuildOf('b10269-1.7.0/macos-arm64')).toBeUndefined()
    expect(upstreamBuildOf('none')).toBeUndefined()
    expect(upstreamBuildOf(undefined)).toBeUndefined()
  })
})

describe('upstreamEngineReadiness', () => {
  it('compares a b<build> floor with the configured build', () => {
    expect(upstreamEngineReadiness('b11454', 'b11443/macos-arm64')).toEqual({
      kind: 'needs_update',
      required: 'b11454',
    })
    expect(upstreamEngineReadiness('b11454', 'b11454').kind).toBe('ready')
  })

  it('holds no floor, an unknown build or a fork tag against the model', () => {
    expect(upstreamEngineReadiness(undefined, 'b1/macos-arm64').kind).toBe(
      'ready'
    )
    expect(upstreamEngineReadiness('b11454', undefined).kind).toBe('ready')
    expect(upstreamEngineReadiness('b10269-1.7.0', 'b1').kind).toBe('ready')
  })
})

describe('decisionEngineReadiness', () => {
  it('asks for the build a stock llama.cpp model needs when the configured one is older', () => {
    expect(
      decisionEngineReadiness(byId('julia-1'), 'b11344/macos-arm64')
    ).toEqual({
      kind: 'needs_update',
      required: 'b11370',
    })
    expect(
      decisionEngineReadiness(byId('clef'), 'b11370/win-cuda-12.4-x64')
    ).toEqual({
      kind: 'needs_update',
      required: 'b11418',
    })
  })

  it('is ready at the floor or past it', () => {
    expect(
      decisionEngineReadiness(byId('julia-1'), 'b11370/macos-arm64').kind
    ).toBe('ready')
    expect(
      decisionEngineReadiness(byId('clef'), 'b11436/macos-arm64').kind
    ).toBe('ready')
  })

  it('leaves TurboQuant models and an unknown build to the core', () => {
    expect(
      decisionEngineReadiness(byId('laya'), 'b1-1.0.0/macos-arm64').kind
    ).toBe('ready')
    expect(decisionEngineReadiness(byId('lev'), undefined).kind).toBe('ready')
  })

  it('names each engine and gives stock llama.cpp the default updater', () => {
    expect(DECISION_ENGINE_UI['llamacpp'].name).toBe('TurboQuant')
    expect(DECISION_ENGINE_UI['llamacpp'].updater.providerId).toBe('llamacpp')
    expect(DECISION_ENGINE_UI['llamacpp-upstream']).toEqual({
      updater: {},
      name: 'llama.cpp',
    })
  })
})

describe('decisionErrorAction', () => {
  it('offers an engine install only for an engine the core checked', () => {
    expect(
      decisionErrorAction({
        code: 'DECISION_ENGINE_UNSUPPORTED',
        message: 'No installed engine build can run the decision model.',
        details: 'b10269-1.6.0/macos-arm64: --decision is not in its -h output',
      })
    ).toBe('install')
  })

  it('offers a retry for a start that timed out or failed', () => {
    for (const code of [
      'MODEL_LOAD_TIMED_OUT',
      'MODEL_LOAD_FAILED',
      'DECISION_UNAVAILABLE',
    ])
      expect(decisionErrorAction({ code, message: 'x' })).toBe('retry')
  })

  it('offers a retry when an older core called an unchecked engine unsupported', () => {
    const error = {
      code: 'DECISION_ENGINE_UNSUPPORTED',
      message:
        'No installed engine build can run the decision model. Install TurboQuant 1.7.0 or newer.',
      details:
        'b10298-2.0.0/macos-arm64: probe failed: Timed out while probing llama.cpp backend capabilities.',
    }
    expect(isUncheckedEngineError(error)).toBe(true)
    expect(decisionErrorAction(error)).toBe('retry')
  })

  it('offers nothing for a model or settings a second start cannot fix', () => {
    for (const code of [
      'DECISION_NOT_CONFIGURED',
      'MODEL_FILE_NOT_FOUND',
      'DECISION_CHECKPOINT_INCOMPLETE',
    ])
      expect(decisionErrorAction({ code, message: 'x' })).toBe('none')
  })
})
