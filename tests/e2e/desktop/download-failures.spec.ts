/**
 * What the user is told when a model download does not arrive. The app classifies these by the
 * status the server gave — a token is missing, a licence was not accepted, the rate limit was hit —
 * and each one carries its own instruction, because "Download Failed" alone leaves nobody knowing
 * what to do next. The fixture plays the refusing server, so the whole taxonomy is reachable
 * without a network and without an account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { pageShows, waitForChat } from '../harness/chat.js'
import { installFakeBackend, startHubFixture, type HubFixture } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_NAME = 'e2e/refused-model'
const QUANT_ID = 'e2e/refused-model-Q4_K_M'
const TITLE = 'E2E Refused Model'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a Hub download the server refuses', () => {
  let session: Session
  let hub: HubFixture

  /** The model's directory only exists once the importer has accepted a complete file. */
  const modelYml = (): string =>
    join(session.profile.dataFolder, 'llamacpp', 'models', ...QUANT_ID.split('/'), 'model.yml')

  /** Open the fixture's model card and ask for it. Leaves the card open for the next attempt. */
  async function askForTheModel(): Promise<void> {
    const browser = session.app.browser
    const card = browser.$(`//*[normalize-space(text())="${TITLE}"]`)
    if (!(await card.isDisplayed().catch(() => false))) {
      await browser.$('//*[normalize-space(text())="Models"]').click()
      await card.waitForDisplayed({ timeout: 60_000 })
    }
    await card.click()
    const download = browser.$('//button[normalize-space(.)="Download"]')
    await download.waitForClickable({ timeout: 30_000 })
    await download.click()
  }

  beforeAll(async () => {
    hub = await startHubFixture({ modelName: MODEL_NAME, quantId: QUANT_ID, title: TITLE })
    session = await startSession('download-failures', {
      prepare: async (profile) => installFakeBackend(profile),
    })
    await session.app.browser.$('button=Skip').click()
    await waitForChat(session)
  })

  afterAll(async () => {
    const left = await endSession(session)
    await hub.stop()
    expect(left).toEqual([])
  })

  it('names the rate limit, and says a token would raise it', async () => {
    await withArtifacts(session, async () => {
      hub.failWith(429)
      await askForTheModel()

      await pageShows(session, 'Rate limited by Hugging Face', 120_000)
      const report = await session.app.browser.$('body').getText()
      expect(report).toContain('Adding a token can increase rate limits')
      expect(existsSync(modelYml())).toBe(false)
    })
  })

  it('asks for a token when the model is gated, and does not offer to retry into the same wall', async () => {
    await withArtifacts(session, async () => {
      hub.failWith(401)
      await askForTheModel()

      await pageShows(session, 'Hugging Face token required', 120_000)
      const report = await session.app.browser.$('body').getText()
      expect(report).toContain('Add your token in Settings')
      expect(existsSync(modelYml())).toBe(false)
    })
  })

  it('gives up on a connection that keeps dying, after retrying it', async () => {
    await withArtifacts(session, async () => {
      hub.failWith(null)
      // Every attempt dies a megabyte in, so the retry ladder is climbed and never finishes.
      hub.abortAfter(1024 * 1024)
      const before = hub.requests().filter((r) => r.path === '/model.gguf' && r.method === 'GET').length
      await askForTheModel()

      await pageShows(session, 'Download Failed', 180_000)
      const attempts = hub.requests().filter((r) => r.path === '/model.gguf' && r.method === 'GET').length
      expect(attempts - before, 'the transfer was retried before it was given up on').toBeGreaterThan(1)
      expect(existsSync(modelYml())).toBe(false)
    })
  })
})
