/**
 * Apple's on-device model, the third local engine the core runs. Whether it can
 * be used at all is the server's own answer to `--check`; the app hides the
 * provider when the answer is anything but "available". Here the bundled server
 * is the core's scripted sidecar, which says it is available and answers a chat.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { FOUNDATION_MODEL_ID, FOUNDATION_MODELS_PROVIDER, installFakeSidecar } from '../harness/bundled-sidecars.js'
import { writeFakeModel } from '../harness/fixtures.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const REPLY = 'ATOMIC-E2E-ON-DEVICE 9a44'

describe.skipIf(process.platform !== 'darwin')('the on-device Foundation Models provider', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('foundation-models', {
      prepare: async (profile) => {
        await installFakeSidecar(profile, 'fm', { reply: REPLY })
        // A llama.cpp model beside it, so the app opens on the chat and the picker has a second group.
        await writeFakeModel(profile, 'e2e/fake-model')
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('is offered when the server says it is available, and the core runs it for a chat', async () => {
    await withArtifacts(session, async () => {
      await waitForChat(session)
      await pickModel(session, FOUNDATION_MODEL_ID, FOUNDATION_MODELS_PROVIDER)
      await send(session, 'hello, on-device model')
      await pageShows(session, REPLY, 120_000)

      const sessions = ((await (await coreRequest(session.profile.dataFolder, '/sessions')).json()) as {
        sessions: { model_id: string; provider: string }[]
      }).sessions
      expect(sessions.map((s) => [s.provider, s.model_id])).toEqual([[FOUNDATION_MODELS_PROVIDER, FOUNDATION_MODEL_ID]])
    })
  }, 300_000)
})

describe.skipIf(process.platform !== 'darwin')('the on-device provider on a Mac that cannot run it', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('foundation-models-absent', {
      prepare: async (profile) => {
        await installFakeSidecar(profile, 'fm', { reply: REPLY, check: 'notEligible' })
        // A llama.cpp model beside it, so the app opens on the chat and the picker has a second group.
        await writeFakeModel(profile, 'e2e/fake-model')
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('is not offered in the model picker', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      await browser.$('[data-test-id="model-picker-trigger"]').click()
      const change = browser.$('button[aria-label="Change model"]')
      if (await change.isExisting()) await change.click()
      // The picker is open — the default provider's gear is there — and the
      // on-device provider's is not.
      await browser.$('[data-test-id="provider-settings-llamacpp-upstream"]').waitForExist({ timeout: 30_000 })
      await browser.pause(2_000)
      expect(await browser.$(`[data-test-id="provider-settings-${FOUNDATION_MODELS_PROVIDER}"]`).isExisting()).toBe(false)
    })
  })
})
