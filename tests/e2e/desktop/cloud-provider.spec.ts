/**
 * A cloud provider added in the UI. The provider is a scripted OpenAI-compatible
 * endpoint on loopback that answers 401 without the right bearer key and records
 * what it receives, so a reply proves the key made the trip. Two trips are
 * checked: the chat in the app, and — since the migration the core owns cloud
 * routing and keeps the key — a request from an outside client of the local API
 * that names the cloud model. That client never knew the provider's key, so only
 * the core can have added it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseFromMenu, pageShows, pageText, pickModel, send, waitForChat } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { startFakeCloud, type FakeCloud } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const PROVIDER_NAME = 'e2e-cloud'
const MODEL = 'e2e-cloud-model'
const REPLY = 'ATOMIC-E2E-CLOUD 3fa9'
const API_KEY = 'e2e-cloud-key-7d1c'
const LOCAL_API_KEY = 'e2e-local-api-key'

/** The input of the settings row whose title a user reads. */
const rowInput = (title: string) =>
  `//*[normalize-space(text())="${title}"]/ancestor::*[.//input][1]//input`

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a cloud provider added in the UI', () => {
  let session: Session
  let cloud: FakeCloud

  beforeAll(async () => {
    cloud = await startFakeCloud({ apiKey: API_KEY, model: MODEL, reply: REPLY })
    session = await startSession('cloud-provider', { apiServer: { apiKey: LOCAL_API_KEY } })
  })

  afterAll(async () => {
    try {
      if (session) expect(await endSession(session)).toEqual([])
    } finally {
      if (cloud) await cloud.stop()
    }
  })

  it('connects with a key, lists the provider\'s models and chats through the core', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      // No local model anywhere: the app opens on onboarding, which is left as it is.
      await browser.$('button=Skip').click()
      await waitForChat(session)

      await browser.$('//*[normalize-space(text())="Cloud"]').click()
      await chooseFromMenu(session, 'button=Select a provider', 'Custom (OpenAI-compatible)')
      await browser.$('input[placeholder="Enter name for provider"]').setValue(PROVIDER_NAME)
      await browser.$('button=Create').click()

      await browser.$(rowInput('Base URL')).waitForDisplayed({ timeout: 30_000 })
      await browser.$(rowInput('Base URL')).setValue(cloud.baseUrl)
      expect(await browser.$(rowInput('Base URL')).getValue()).toBe(cloud.baseUrl)
      await browser.$(rowInput('API key')).setValue(API_KEY)
      await browser.$('button=Connect').click()
      await pageShows(session, 'Connected', 30_000)

      // Connecting already asked the provider for its models, with the key.
      await expect
        .poll(() => cloud.requests(), { timeout: 30_000 })
        .toContainEqual({ method: 'GET', path: '/v1/models', authorization: `Bearer ${API_KEY}`, status: 200 })

      // The model is added by hand, the way the page offers for a provider of
      // one's own. "Reload models" cannot be used here: it refreshes the provider
      // registry first and gives up when that is unreachable, which it is in an
      // e2e build by design — before it ever asks the provider itself.
      await browser
        .$('//button[normalize-space(.)="Reload models" or normalize-space(.)="Refreshing..."]/following-sibling::button[1]')
        .click()
      await browser.$('input[placeholder="Enter model ID"]').setValue(MODEL)
      await browser.$('button=Add Model').click()
      await pageShows(session, '1 model', 15_000)

      await browser.$('//*[normalize-space(text())="New Chat"]').click()
      await waitForChat(session)
      await pickModel(session, MODEL)
      await send(session, 'hello, cloud')
      await pageShows(session, REPLY, 90_000)

      // The completion went to the provider with the key, as a stream.
      expect(cloud.requests()).toContainEqual({
        method: 'POST',
        path: '/v1/chat/completions',
        authorization: `Bearer ${API_KEY}`,
        status: 200,
      })
      expect(cloud.completions()).toContainEqual(
        expect.objectContaining({
          model: MODEL,
          stream: true,
          messages: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'hello, cloud' }),
          ]),
        })
      )

      // The core was told about the provider, and does not hand its key back.
      const known = await (await coreRequest(dataFolder, '/cloud/providers')).text()
      expect(known).toContain(PROVIDER_NAME)
      expect(known).toContain(cloud.baseUrl)
      expect(known).not.toContain(API_KEY)

      // An outside client of the local API asks for the cloud model. It sends
      // the local API's key; the provider must receive its own.
      // Nobody started the server: auto-start is off in this profile. The chat
      // above did, because the app itself reaches a cloud provider through the
      // core's local API — which is what makes that chat a test of the core.
      await browser.$('a=API').click()
      await browser.$('button=Stop server').waitForDisplayed({ timeout: 60_000 })
      await pageShows(session, 'Ready', 15_000)
      const localApi = `http://127.0.0.1:${session.apiPort}/v1`
      const local = { authorization: `Bearer ${LOCAL_API_KEY}`, 'content-type': 'application/json' }
      const listed = ((await (await fetch(`${localApi}/models`, { headers: local })).json()) as { data: { id: string }[] }).data
      const cloudModelId = listed.map((m) => m.id).find((id) => id.includes(MODEL))
      expect(cloudModelId, `the local API lists ${JSON.stringify(listed.map((m) => m.id))}`).toBeDefined()

      // A client with the wrong local key cannot make the core spend the
      // provider's private key on its behalf.
      const beforeDenied = cloud.requests().length
      const denied = await fetch(`${localApi}/chat/completions`, {
        method: 'POST',
        headers: { ...local, authorization: 'Bearer wrong-local-key' },
        body: JSON.stringify({ model: cloudModelId, messages: [{ role: 'user', content: 'denied' }] }),
      })
      expect(denied.status).toBe(401)
      expect(cloud.requests()).toHaveLength(beforeDenied)

      const before = cloud.requests().length
      const completion = await fetch(`${localApi}/chat/completions`, {
        method: 'POST',
        headers: local,
        body: JSON.stringify({ model: cloudModelId, stream: false, messages: [{ role: 'user', content: 'ping' }] }),
      })
      expect(completion.status).toBe(200)
      const answer = (await completion.json()) as { choices: { message: { content: string } }[] }
      expect(answer.choices[0]!.message.content).toBe(REPLY)
      expect(cloud.requests().slice(before)).toEqual([
        { method: 'POST', path: '/v1/chat/completions', authorization: `Bearer ${API_KEY}`, status: 200 },
      ])
      expect(cloud.completions().at(-1)).toMatchObject({
        model: MODEL,
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
      })

      // The key is a secret: it reached the provider, and it is in neither the
      // core's settings file nor the app's log.
      expect(await readFile(join(dataFolder, 'atomic-core', 'settings.json'), 'utf8')).not.toContain(API_KEY)
      expect(await readFile(join(dataFolder, 'logs', 'app.log'), 'utf8')).not.toContain(API_KEY)
      expect(await pageText(session)).not.toContain(API_KEY)
    })
  })
})
