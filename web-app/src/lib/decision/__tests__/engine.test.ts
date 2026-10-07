import { describe, expect, it } from 'vitest'

import { getBaselineDecisionCatalog } from '@/services/decision-catalog-registry'

import {
  DECISION_ENGINE_UI,
  decisionEngineReadiness,
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
