import { describe, expect, it } from 'vitest'
import {
  resolveMessageExecutionRoute,
  type RouteInput,
} from '@/lib/agent-route'

const agentEligible: RouteInput = {
  legacyChatEngine: false,
  providerBlockReason: null,
  hasAudioAttachment: false,
  dflashEnabled: false,
}

describe('resolveMessageExecutionRoute', () => {
  it('defaults to the agent engine', () => {
    expect(resolveMessageExecutionRoute(agentEligible)).toEqual({
      route: 'agent-ipc',
      reason: 'default-agent',
    })
  })

  it('honors the legacy chat engine escape hatch above everything else', () => {
    expect(
      resolveMessageExecutionRoute({ ...agentEligible, legacyChatEngine: true })
    ).toEqual({ route: 'chat-transport', reason: 'legacy-setting' })
  })

  it('falls back for providers the agent cannot drive', () => {
    expect(
      resolveMessageExecutionRoute({
        ...agentEligible,
        providerBlockReason: 'unsupported-provider',
      })
    ).toEqual({ route: 'chat-transport', reason: 'provider-unsupported' })
  })

  it('falls back for remote providers with no API key', () => {
    expect(
      resolveMessageExecutionRoute({
        ...agentEligible,
        providerBlockReason: 'missing-api-key',
      })
    ).toEqual({ route: 'chat-transport', reason: 'missing-api-key' })
  })

  it('falls back for turns carrying an audio attachment', () => {
    expect(
      resolveMessageExecutionRoute({
        ...agentEligible,
        hasAudioAttachment: true,
      })
    ).toEqual({ route: 'chat-transport', reason: 'audio-attachment' })
  })

  it('falls back when upstream dflash mode is enabled', () => {
    expect(
      resolveMessageExecutionRoute({ ...agentEligible, dflashEnabled: true })
    ).toEqual({ route: 'chat-transport', reason: 'dflash' })
  })
})
