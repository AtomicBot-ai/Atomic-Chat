import { beforeEach, describe, expect, it, vi } from 'vitest'

import posthog from 'posthog-js'
import {
  captureSubscriptionCardShown,
  captureSubscriptionConnectResult,
  captureSubscriptionConnectStarted,
  captureSubscriptionDisconnected,
} from '@/lib/subscription-telemetry'
import { classifySubscriptionFailure } from '@/lib/telemetry'

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))

const lastCall = () => {
  const calls = vi.mocked(posthog.capture).mock.calls
  return calls[calls.length - 1] as [string, Record<string, unknown>]
}

beforeEach(() => {
  vi.mocked(posthog.capture).mockClear()
})

describe('subscription events', () => {
  it('records which surface the card was shown on', () => {
    captureSubscriptionCardShown({ provider: 'chatgpt', surface: 'onboarding' })

    expect(lastCall()).toEqual([
      'subscription_card_shown',
      expect.objectContaining({ provider: 'chatgpt', surface: 'onboarding' }),
    ])
  })

  it('reports a successful connection with the plan and model count', () => {
    captureSubscriptionConnectResult({
      provider: 'chatgpt',
      surface: 'onboarding',
      connectResult: 'connected',
      planType: 'Plus',
      modelCount: 4,
      durationMs: 18_000,
    })

    const props = lastCall()[1]
    expect(props).toMatchObject({
      connect_result: 'connected',
      plan_type: 'Plus',
      model_count: 4,
      duration_ms: 18_000,
    })
    // PostHog typed `status` numeric project-wide; strings written to it read
    // back as null, which is why this field is `connect_result`.
    expect(props).not.toHaveProperty('status')
  })

  it('carries no account identity', () => {
    captureSubscriptionConnectResult({
      provider: 'chatgpt',
      surface: 'settings',
      connectResult: 'connected',
      planType: 'Plus',
    })

    expect(JSON.stringify(lastCall()[1])).not.toContain('@')
  })

  it('reports the start and the disconnect', () => {
    captureSubscriptionConnectStarted({
      provider: 'chatgpt',
      surface: 'settings',
    })
    expect(lastCall()[0]).toBe('subscription_connect_started')

    captureSubscriptionDisconnected({
      provider: 'chatgpt',
      surface: 'settings',
    })
    expect(lastCall()[0]).toBe('subscription_disconnected')
  })
})

describe('classifySubscriptionFailure', () => {
  // Verbatim from src-tauri/src/core/auth/chatgpt.rs and commands.rs.
  it.each([
    ['sign-in cancelled', 'cancelled'],
    ['callback channel closed', 'cancelled'],
    ['timed out waiting for the browser sign-in', 'timeout'],
    [
      "cannot listen on 127.0.0.1:1455 for the sign-in callback (Address in use). This port is fixed by OpenAI's redirect URI",
      'port_busy',
    ],
    ['cannot open the browser for sign-in: no opener', 'browser_open_failed'],
    ['callback state did not match this sign-in', 'state_mismatch'],
    ['reauthorization required: invalid_grant', 'reauthorization_required'],
    ['token request rejected (400): bad things', 'token_rejected'],
    ['token request failed: connection reset', 'network'],
    ['access_denied: user declined', 'provider_rejected'],
    ['callback carried no authorization code', 'provider_rejected'],
    ['sign-in returned no refresh token', 'provider_rejected'],
  ])('reads %j as %s', (message, expected) => {
    expect(classifySubscriptionFailure(new Error(message))).toBe(expected)
  })

  it('separates a user cancelling from the flow being broken', () => {
    // Both arrive as a rejected `chatgptLogin()`, so without this they were
    // one number.
    expect(classifySubscriptionFailure('sign-in cancelled')).toBe('cancelled')
    expect(classifySubscriptionFailure('cannot listen on 127.0.0.1:1455')).toBe(
      'port_busy'
    )
  })

  it('falls back rather than mislabelling a message that drifted', () => {
    expect(classifySubscriptionFailure(new Error('something new'))).toBe(
      'unknown'
    )
    expect(classifySubscriptionFailure(undefined)).toBe('unknown')
    expect(classifySubscriptionFailure({})).toBe('unknown')
  })
})
