import { describe, expect, it, vi } from 'vitest'
import { isContextLimitError } from '@/utils/error'
import { withForcedContextOverflow } from '../force-context-overflow'

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      getProviderByName: (name: string) =>
        name === 'llamacpp'
          ? {
              models: [
                {
                  id: 'qwen',
                  settings: { ctx_len: { controller_props: { value: 8192 } } },
                },
              ],
            }
          : undefined,
    }),
  },
}))

const URL_ = 'http://127.0.0.1:41234/v1/chat/completions'

function passThrough() {
  return vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
}

describe('withForcedContextOverflow (dev preview of a chat that no longer fits)', () => {
  it("answers a streamed chat turn with llama-server's overflow, which the app reads as a context overflow", async () => {
    const inner = passThrough()
    const fetch = withForcedContextOverflow('llamacpp', 'qwen', inner)

    const response = await fetch(URL_, {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(inner).not.toHaveBeenCalled()
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: {
        type: string
        message: string
        n_ctx: number
        n_prompt_tokens: number
      }
    }
    expect(body.error.type).toBe('exceed_context_size_error')
    expect(body.error.n_prompt_tokens).toBeGreaterThan(body.error.n_ctx)
    expect(isContextLimitError(body.error.message)).toBe(true)
  })

  it('sends a request that is not a streamed chat turn as it is', async () => {
    const inner = passThrough()
    const fetch = withForcedContextOverflow('llamacpp', 'qwen', inner)

    const titled = await fetch(URL_, {
      method: 'POST',
      body: JSON.stringify({ model: 'qwen', stream: false, messages: [] }),
    })
    const models = await fetch('http://127.0.0.1:41234/v1/models', {
      method: 'GET',
    })

    expect(inner).toHaveBeenCalledTimes(2)
    expect(titled.status).toBe(200)
    expect(models.status).toBe(200)
  })

  it('names the window the model is set to, and a default for a model it does not know', async () => {
    const known = withForcedContextOverflow('llamacpp', 'qwen', passThrough())
    const unknown = withForcedContextOverflow('mlx', 'other', passThrough())
    const init = {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [] }),
    }

    const knownBody = (await (await known(URL_, init)).json()) as {
      error: { n_ctx: number }
    }
    const unknownBody = (await (await unknown(URL_, init)).json()) as {
      error: { n_ctx: number }
    }

    expect(knownBody.error.n_ctx).toBe(8192)
    expect(unknownBody.error.n_ctx).toBeGreaterThan(0)
  })
})
