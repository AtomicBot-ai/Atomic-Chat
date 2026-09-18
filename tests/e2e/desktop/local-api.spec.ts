/**
 * The local OpenAI-compatible API, as an outside program sees it. The user
 * starts the server in the app; from then on the test is a plain HTTP client
 * with no access to the app — the position Codex, OpenCode or a script is in.
 * The listener belongs to the core, so this also proves the app can hand the
 * core a host, a port and a key, and that the core serves a model the app knows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-API-REPLY 91be'
const API_KEY = 'e2e-local-api-key'

/** Reads an SSE chat stream to its end and returns the concatenated text. */
async function streamedText(response: Response): Promise<{ text: string; chunks: number; done: boolean }> {
  const body = await response.text()
  let text = ''
  let chunks = 0
  let done = false
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      done = true
      continue
    }
    const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta
    if (delta?.content) {
      text += delta.content
      chunks += 1
    }
  }
  return { text, chunks, done }
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the local API server', () => {
  let session: Session
  let baseUrl = ''

  beforeAll(async () => {
    session = await startSession('local-api', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
      // The key field in the API settings has no accessible name to type into
      // yet; the value is a test string, stored where the app keeps the real one.
      apiServer: { apiKey: API_KEY },
    })
    baseUrl = `http://127.0.0.1:${session.apiPort}/v1`
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('is closed until the user starts it, then serves authenticated clients, then closes again', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const authorized = { authorization: `Bearer ${API_KEY}` }

      await browser.$('[data-testid="chat-input"]').waitForDisplayed({ timeout: 60_000 })

      // Auto-start is off in this profile, so nothing listens yet.
      await expect(fetch(`${baseUrl}/models`, { headers: authorized })).rejects.toThrow()

      await browser.$('a=API').click()
      await browser.$('button=Start server').click()
      await browser.$('button=Stop server').waitForDisplayed({ timeout: 60_000 })

      // Without the key the request is refused; with it the app's model is listed.
      expect((await fetch(`${baseUrl}/models`)).status).toBe(401)
      const models = await fetch(`${baseUrl}/models`, { headers: authorized })
      expect(models.status).toBe(200)
      const listed = ((await models.json()) as { data: { id: string }[] }).data.map((m) => m.id)
      expect(listed).toContain(MODEL_ID)

      // A streamed completion from a client that never touched the UI: the core
      // loads the model on demand and relays the backend's stream.
      const completion = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...authorized, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL_ID,
          stream: true,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
      expect(completion.status).toBe(200)
      expect(completion.headers.get('content-type')).toContain('text/event-stream')
      const streamed = await streamedText(completion)
      expect(streamed.text).toBe(REPLY)
      expect(streamed.chunks).toBeGreaterThan(1)
      expect(streamed.done).toBe(true)

      await browser.$('button=Stop server').click()
      await browser.$('button=Start server').waitForDisplayed({ timeout: 30_000 })
      await expect(fetch(`${baseUrl}/models`, { headers: authorized })).rejects.toThrow()
    })
  })
})
