/**
 * Fake HTTP plumbing shared by the provider adapter tests.
 *
 * Not a `.test.ts` file, so vitest does not collect it.
 *
 * The fakes model the one property of a real `Response` the synchronous
 * adapters rely on: headers are available before the body settles. Each
 * provider's test file owns its fixtures and routing; this only builds the
 * responses and records what was sent.
 */

export type RecordedRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
}

/** A Response-like object whose body is produced lazily by `body`. */
export function fakeResponse(
  status: number,
  body: () => Promise<unknown>,
  headers: Record<string, string> = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: body,
  } as unknown as Response
}

export function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): Response {
  return fakeResponse(status, () => Promise.resolve(payload), {
    'content-type': 'application/json',
    ...headers,
  })
}

/** A promise with its resolvers exposed. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Read whatever body a request carried, as the server would see it. */
export function decodeBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  if (body instanceof FormData) {
    const fields: Record<string, unknown> = {}
    body.forEach((value, key) => {
      fields[key] = value
    })
    return fields
  }
  return body
}

/** The fetch error a refused connection produces. */
export function connectionRefused(): TypeError {
  return new TypeError('fetch failed')
}

/** A fetch that never answers until its signal aborts. */
export function hangUntilAborted(
  signal: AbortSignal | undefined
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : Object.assign(new Error('The operation was aborted.'), {
              name: 'AbortError',
            })
      )
    if (signal?.aborted) abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
}
