/**
 * Server → Overview's setup guide on a first visit. Picking an agent and
 * "Configure & start" does what All integrations' Run does without the
 * terminal: it makes the chosen model the server's, starts the server with
 * it, and writes the agent's own config so that it talks to that server.
 * Connections then lists the agent as set up.
 *
 * The home is the profile's stand-in and `codex` a stand-in on the app's PATH
 * that is never executed (as in launch-integration.spec.ts).
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clickWhenStill, pageShows, waitForChat } from '../harness/chat.js'
import { writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'
import { openSection } from '../harness/navigation.js'

const MODEL_ID = 'e2e/fake-model'
const AGENT = 'Codex CLI'
const LOCAL_API_KEY = 'e2e-local-api-key'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the Server setup guide on a first visit', () => {
  let session: Session
  let configPath = ''

  beforeAll(async () => {
    session = await startSession('server-setup-guide', {
      apiServer: { apiKey: LOCAL_API_KEY },
      // A first visit: the guide opens by itself.
      webviewSeed: {
        'atomic-server-setup': JSON.stringify({ state: { setupDone: false }, version: 1 }),
      },
      prepare: async (profile) => {
        await writeFakeModel(profile, MODEL_ID)
        await writeFile(join(profile.binDir, 'codex'), '#!/bin/sh\nexit 0\n')
        await chmod(join(profile.binDir, 'codex'), 0o755)
        await mkdir(join(profile.home, '.codex'), { recursive: true })
      },
    })
    // Codex runs on Atomic Chat's own profile; its shared config.toml stays the user's.
    configPath = join(session.profile.home, '.codex', 'atomic-chat.config.toml')
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('connects an agent: the model, the server and the agent config in one go', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const localApi = `http://127.0.0.1:${session.apiPort}/v1`

      await waitForChat(session)
      // Nothing listens yet: auto-start is off in this profile.
      await expect(fetch(`${localApi}/models`)).rejects.toThrow()

      await openSection(browser, 'server')
      await pageShows(session, 'What would you like to connect?', 30_000)
      await clickWhenStill(session, '//button[contains(normalize-space(.), "Configure an agent")]')
      await clickWhenStill(session, `//button[contains(@class, "sp-agent-choice")][contains(normalize-space(.), "${AGENT}")]`)
      await pageShows(session, `Connect ${AGENT}`, 15_000)
      await clickWhenStill(session, '//button[normalize-space(.)="Configure & start"]')
      await pageShows(session, `${AGENT} is set up`, 120_000)

      // The server is up with the model, and only for the key.
      const unauthorized = await fetch(`${localApi}/models`)
      expect(unauthorized.status).toBe(401)
      const models = await fetch(`${localApi}/models`, { headers: { authorization: `Bearer ${LOCAL_API_KEY}` } })
      expect(models.status).toBe(200)

      // The agent's profile names the local API and the model the guide chose,
      // and nothing was written into the config Codex shares with ChatGPT.
      const configured = await readFile(configPath, 'utf8')
      expect(configured).toContain(localApi)
      expect(configured).toContain(MODEL_ID)
      expect(await readFile(join(session.profile.home, '.codex', 'config.toml'), 'utf8').catch(() => null)).toBeNull()

      // Connections lists it as set up.
      await clickWhenStill(session, '//button[contains(normalize-space(.), "View connection details")]')
      await pageShows(session, 'Connected tools', 15_000)
      await pageShows(session, AGENT, 15_000)
    })
  }, 300_000)
})
