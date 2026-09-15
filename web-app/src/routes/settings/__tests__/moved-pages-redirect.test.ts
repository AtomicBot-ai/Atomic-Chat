import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  redirect: (options: Record<string, unknown>) =>
    Object.assign(new Error('redirect'), { redirect: options }),
}))

import { Route as LocalApiServerRoute } from '../local-api-server'

type RedirectPayload = { to: string; search?: Record<string, unknown> }

const followRedirect = (route: unknown): RedirectPayload => {
  const withBeforeLoad = route as {
    beforeLoad: (ctx: { search: Record<string, unknown> }) => void
  }
  try {
    withBeforeLoad.beforeLoad({ search: {} })
  } catch (error) {
    return (error as { redirect: RedirectPayload }).redirect
  }
  throw new Error('the old address must always redirect')
}

describe('/settings/local-api-server', () => {
  it('forwards to the API page inside Settings', () => {
    expect(followRedirect(LocalApiServerRoute).to).toBe('/settings/api')
  })
})
