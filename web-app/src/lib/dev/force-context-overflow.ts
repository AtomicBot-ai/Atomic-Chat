import { useModelProvider } from '@/hooks/useModelProvider'
import { DEFAULT_CTX_LEN, readModelCtxLen } from '@/lib/context-size'

/**
 * Dev preview of a chat that no longer fits its window:
 * `VITE_FORCE_CONTEXT_OVERFLOW=true make dev-fast`.
 *
 * Every streamed `/chat/completions` turn is answered the way llama-server
 * answers a prompt larger than its window, and nothing else is faked: the
 * real recovery runs (the window grows to the device maximum if it is below
 * it, then the history is compacted once through the core), and the error
 * card shows what a user sees once nothing more helps. Requests that are not
 * streamed (thread titles and the like) go through untouched. Never active in
 * a release build.
 */
export const FORCE_CONTEXT_OVERFLOW =
  import.meta.env.DEV && import.meta.env.VITE_FORCE_CONTEXT_OVERFLOW === 'true'

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

function isStreamedChatTurn(
  input: RequestInfo | URL,
  init?: RequestInit
): boolean {
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return false
  if (!new URL(urlOf(input)).pathname.endsWith('/chat/completions'))
    return false
  if (typeof init?.body !== 'string') return false
  try {
    return (JSON.parse(init.body) as { stream?: unknown }).stream === true
  } catch {
    return false
  }
}

/** The model's window as the app knows it, for the numbers in the answer. */
function windowOf(providerName: string, modelId: string): number {
  const provider = useModelProvider.getState().getProviderByName(providerName)
  const model = provider?.models.find((m) => m.id === modelId)
  return readModelCtxLen(model) ?? DEFAULT_CTX_LEN
}

/**
 * llama-server's own answer to an oversized prompt, as the core captured it
 * from b11642 (`atomic-chat-core` `src/server/public/errors.test.ts`).
 */
export function contextOverflowResponse(
  promptTokens: number,
  windowTokens: number
): Response {
  const body = {
    error: {
      code: 400,
      message: `request (${promptTokens} tokens) exceeds the available context size (${windowTokens} tokens), try increasing it`,
      type: 'exceed_context_size_error',
      n_prompt_tokens: promptTokens,
      n_ctx: windowTokens,
    },
  }
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** `inner`, except that a streamed chat turn is refused as too large for the window. */
export function withForcedContextOverflow<F extends Fetch>(
  providerName: string,
  modelId: string,
  inner: F
): F {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isStreamedChatTurn(input, init)) return inner(input, init)
    const windowTokens = windowOf(providerName, modelId)
    // Roughly four characters a token, and always more than the window.
    const promptTokens = Math.max(
      windowTokens + 1,
      Math.ceil((init!.body as string).length / 4)
    )
    console.warn(
      `[dev] VITE_FORCE_CONTEXT_OVERFLOW: ${providerName}/${modelId} turn refused (${promptTokens} > ${windowTokens} tokens)`
    )
    return contextOverflowResponse(promptTokens, windowTokens)
  }) as F
}
