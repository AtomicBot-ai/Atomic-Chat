import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  redirect: (options: Record<string, unknown>) =>
    Object.assign(new Error('redirect'), { redirect: options }),
}))

import { Route } from '../$modelId'

type RedirectPayload = {
  to: string
  replace: boolean
  search: Record<string, unknown>
}

const followRedirect = (
  modelId: string,
  search: Record<string, unknown> = {}
): RedirectPayload => {
  const route = Route as unknown as {
    beforeLoad: (ctx: {
      params: { modelId: string }
      search: Record<string, unknown>
    }) => void
  }
  try {
    route.beforeLoad({ params: { modelId }, search })
  } catch (error) {
    return (error as { redirect: RedirectPayload }).redirect
  }
  throw new Error('the legacy model page must always redirect')
}

describe('/hub/$modelId', () => {
  it('forwards a legacy deep link to the split view', () => {
    const payload = followRedirect('Qwen/Qwen3.5-4B-GGUF')

    expect(payload.to).toBe('/hub/')
    expect(payload.replace).toBe(true)
    expect(payload.search).toEqual({ model: 'Qwen/Qwen3.5-4B-GGUF' })
  })

  it('carries the repo and query params across', () => {
    const payload = followRedirect('Qwen/Qwen3.5-4B-GGUF', {
      repo: 'Qwen/Qwen3.5-4B-GGUF',
      q: 'qwen',
    })

    expect(payload.search).toEqual({
      model: 'Qwen/Qwen3.5-4B-GGUF',
      repo: 'Qwen/Qwen3.5-4B-GGUF',
      q: 'qwen',
    })
  })

  it('keeps unrelated search params out of the target URL', () => {
    const route = Route as unknown as {
      validateSearch: (search: Record<string, unknown>) => Record<string, unknown>
    }

    expect(route.validateSearch({ repo: 'a/b', junk: 1, q: 2 })).toEqual({
      repo: 'a/b',
      q: undefined,
    })
  })
})
