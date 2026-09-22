/**
 * The second llama.cpp provider. `llamacpp` is the TurboQuant fork, off on a
 * fresh install; `llamacpp-upstream` is the default. Both list the same model
 * folder and both are run by the core, each from its own backend directory. The
 * scenario turns the fork on in settings and runs one model under each, telling
 * them apart by the reply of the scripted backend installed for each.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreRequest } from '../harness/core.js'
import { isAlive, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { FAKE_BACKEND, FAKE_PROVIDER, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const FORK_PROVIDER = 'llamacpp'
// Higher than any fork release, for the reason the upstream fixture is b99999.
const FORK_VERSION = 'b99999-9.9.9'
const FORK_REPLY = 'ATOMIC-E2E-TURBOQUANT 2a9e'
const UPSTREAM_REPLY = 'ATOMIC-E2E-UPSTREAM 7c10'

interface CoreSession {
  pid: number
  model_id: string
  provider?: string
}

async function sessions(dataFolder: string): Promise<(CoreSession & { exe: string })[]> {
  const response = await coreRequest(dataFolder, '/sessions')
  const listed = ((await response.json()) as { sessions: CoreSession[] }).sessions
  const journal = JSON.parse(await readFile(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8')) as {
    processes: { pid: number; exe: string }[]
  }
  return listed.map((s) => ({ ...s, exe: journal.processes.find((p) => p.pid === s.pid)?.exe ?? '' }))
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the TurboQuant provider', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('turboquant-provider', {
      alsoAllowedBackends: [`${FORK_PROVIDER}:${FORK_VERSION}/${FAKE_BACKEND}`],
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: UPSTREAM_REPLY })
        await installFakeBackend(profile, { provider: FORK_PROVIDER, version: FORK_VERSION, reply: FORK_REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('is turned on in settings and runs a model from its own backend, beside the default provider', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)

      // Off on a fresh install; the user turns it on.
      await browser.$('//*[normalize-space(text())="Settings"]').click()
      // Disabled providers sit under a fold in the settings menu, which may
      // already be open.
      const entry = browser.$('//span[normalize-space(.)="llama.cpp turboquant"]')
      const fold = browser.$('//button[contains(normalize-space(.), "1 disabled")]')
      await fold.waitForDisplayed({ timeout: 30_000 })
      if (!(await entry.isExisting())) await fold.click()
      await entry.click()
      const toggle = browser.$('//h1[normalize-space(.)="llama.cpp turboquant"]/following::button[@role="switch"][1]')
      await toggle.waitForClickable({ timeout: 30_000 })
      expect(await toggle.getAttribute('aria-checked')).toBe('false')
      await toggle.click()
      await browser.waitUntil(async () => (await toggle.getAttribute('aria-checked')) === 'true', { timeout: 15_000 })

      // The model under the fork: the fork's backend answers, run by the core.
      await browser.$('//*[normalize-space(text())="New Chat"]').click()
      await waitForChat(session)
      await pickModel(session, MODEL_ID, FORK_PROVIDER)
      await send(session, 'who runs you')
      await pageShows(session, FORK_REPLY, 90_000)
      const underFork = await sessions(dataFolder)
      expect(underFork.map((s) => [s.provider, s.model_id])).toEqual([[FORK_PROVIDER, MODEL_ID]])
      expect(underFork[0]!.exe).toContain(`/${FORK_PROVIDER}/backends/${FORK_VERSION}/`)

      // The same model under the default provider: the other backend answers.
      await browser.$('//*[normalize-space(text())="New Chat"]').click()
      await waitForChat(session)
      await pickModel(session, MODEL_ID, FAKE_PROVIDER)
      await send(session, 'and now')
      await pageShows(session, UPSTREAM_REPLY, 90_000)
      // One model, one process: the fork's was replaced, not left beside it.
      const underUpstream = await sessions(dataFolder)
      expect(underUpstream.map((s) => [s.provider, s.model_id])).toEqual([[FAKE_PROVIDER, MODEL_ID]])
      expect(underUpstream[0]!.exe).toContain(`/${FAKE_PROVIDER}/backends/`)
      expect(isAlive(underFork[0]!.pid)).toBe(false)
    })
  }, 300_000)
})
