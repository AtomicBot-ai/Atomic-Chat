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
import { pageShows, pageText, pickModel, send, waitForChat } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { startFakeCloud, type FakeCloud } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'
import { openSection, openServerConnections, openSidebarRow, startNewChat, waitForServerPower } from '../harness/navigation.js'

const PROVIDER_NAME = 'e2e-cloud'
/** How the page titles a provider it does not know: the name, capitalised. */
const PROVIDER_TITLE = 'E2e-cloud'
const MODEL = 'e2e-cloud-model'
const REPLY = 'ATOMIC-E2E-CLOUD 3fa9'
const API_KEY = 'e2e-cloud-key-7d1c'
const LOCAL_API_KEY = 'e2e-local-api-key'

/** The input of the dialog field whose label a user reads. */
const fieldInput = (label: string) =>
  `//label[starts-with(normalize-space(.), "${label}")]//input`

/** A button inside the Custom Endpoint card of `provider`. */
const endpointButton = (provider: string, text: string) =>
  `//article[@aria-label="${provider}"]//button[normalize-space(.)="${text}"]`

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

      // A server of one's own is added on Custom Endpoint: a name, its
      // address and its key, in one dialog.
      await openSection(browser, 'models')
      await openSidebarRow(browser, 'Custom Endpoint')
      await browser.$('button=Add New Endpoint').click()
      await browser.$(fieldInput('Name')).waitForDisplayed({ timeout: 30_000 })
      await browser.$(fieldInput('Name')).setValue(PROVIDER_NAME)
      await browser.$(fieldInput('Base URL')).setValue(cloud.baseUrl)
      expect(await browser.$(fieldInput('Base URL')).getValue()).toBe(cloud.baseUrl)
      await browser.$(fieldInput('API key')).setValue(API_KEY)
      await browser.$('button=Save endpoint').click()

      // Saving asked the provider for its models, with the key, and kept the
      // one it lists.
      await expect
        .poll(() => cloud.requests(), { timeout: 30_000 })
        .toContainEqual({ method: 'GET', path: '/v1/models', authorization: `Bearer ${API_KEY}`, status: 200 })
      await pageShows(session, 'Connected · 1 model', 30_000)

      // Ping asks the same listing once more and reports how it answered.
      const listings = cloud.requests().filter((r) => r.path === '/v1/models').length
      await browser.$(endpointButton(PROVIDER_TITLE, 'Ping')).click()
      await pageShows(session, 'Ping successful', 15_000)
      expect(cloud.requests().filter((r) => r.path === '/v1/models')).toHaveLength(listings + 1)

      await startNewChat(browser)
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
      await openServerConnections(browser)
      await waitForServerPower(browser, 'Stop')
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
