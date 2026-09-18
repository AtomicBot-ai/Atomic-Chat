/**
 * The API page's request log. The public server belongs to the core now; what
 * an outside client sends to it reaches the page as events the app relays, so
 * this is the path "core → Rust relay → webview" seen from the user's chair: a
 * request made by a program the app knows nothing about shows up in the list,
 * and opens to the prompt it carried and the reply it got.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows, pageText } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-INSPECTED 6b1f'
const PROMPT = 'inspect me e2e 40c2'
const API_KEY = 'e2e-local-api-key'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the API request log', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('api-inspector', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
      apiServer: { apiKey: API_KEY },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('lists a request an outside client made and opens it to its prompt and reply', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const baseUrl = `http://127.0.0.1:${session.apiPort}/v1`
      await browser.$('[data-testid="chat-input"]').waitForDisplayed({ timeout: 60_000 })
      await browser.$('a=API').click()
      await browser.$('button=Start server').click()
      await browser.$('button=Stop server').waitForDisplayed({ timeout: 60_000 })

      const completion = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL_ID, stream: true, messages: [{ role: 'user', content: PROMPT }] }),
      })
      expect(completion.status).toBe(200)
      await completion.text()
      expect((await fetch(`${baseUrl}/models`)).status).toBe(401)

      // It appears while the page is open — nobody reopened or refreshed it — as
      // a finished row, which shows the reply.
      const row = browser.$(`//button[contains(normalize-space(.), "${REPLY}")]`)
      await row.waitForDisplayed({ timeout: 15_000 })
      await row.click()

      // Opened, it shows what the client asked and what it was told.
      await pageShows(session, PROMPT, 10_000)
      const page = (await pageText(session)).replace(/\s+/g, ' ')
      expect(page).toContain('POST /v1/chat/completions')
      expect(page).toContain(`Prompt${PROMPT}`)
      expect(page).toContain(`Reply${REPLY}`)
      expect(page).toContain('Stop reasonstop')

      // The request refused for lack of a key is there too, as the one error.
      expect(page).toContain('Requests2')
      expect(page).toContain('Completed1')
      expect(page).toContain('Errors1')
    })
  })
})
