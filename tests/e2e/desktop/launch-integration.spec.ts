/**
 * The Integrations page pointing a coding agent at the local API. "Run" does
 * three things for the user: starts the local server if it is down, writes the
 * agent's own config file so that it talks to that server, and opens a terminal
 * with the agent in it. The config lives in the user's home, next to settings
 * the user wrote themselves, so what matters most is what it leaves alone.
 *
 * The home is the profile's stand-in, `codex` is a stand-in on the app's PATH
 * that is never executed, and an e2e build writes down the terminal it would
 * have opened instead of opening one on the desktop of whoever runs the tests.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clickWhenStill, coreSessions, pageShows, pickModel, waitForChat } from '../harness/chat.js'
import { writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const AGENT = 'Codex CLI'
const LOCAL_API_KEY = 'e2e-local-api-key'

/** What the user already had in ~/.codex/config.toml, none of it Atomic Chat's business. */
const USERS_OWN_CONFIG = `approval_policy = "on-request"

[mcp_servers.my_tool]
command = "my-tool"
args = ["--serve"]
`

const runButton = `//*[normalize-space(text())="${AGENT}"]/ancestor::*[.//button[normalize-space(.)="Run"]][1]//button[normalize-space(.)="Run"]`

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('running a coding agent from the Integrations page', () => {
  let session: Session
  let configPath = ''
  let terminalsPath = ''
  let afterFirstRun = ''
  let afterSecondRun = ''

  const openedTerminals = async (): Promise<string[]> =>
    (await readFile(terminalsPath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)

  beforeAll(async () => {
    session = await startSession('launch-integration', {
      apiServer: { apiKey: LOCAL_API_KEY },
      prepare: async (profile) => {
        await writeFakeModel(profile, MODEL_ID)
        await writeFile(join(profile.binDir, 'codex'), '#!/bin/sh\nexit 0\n')
        await chmod(join(profile.binDir, 'codex'), 0o755)
        await mkdir(join(profile.home, '.codex'), { recursive: true })
        await writeFile(join(profile.home, '.codex', 'config.toml'), USERS_OWN_CONFIG)
      },
    })
    configPath = join(session.profile.home, '.codex', 'config.toml')
    terminalsPath = join(session.profile.root, 'opened-terminals.jsonl')
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('points the agent at the local API, keeps the user\'s own settings, and does the same thing twice', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const localApi = `http://127.0.0.1:${session.apiPort}/v1`

      // The agent is configured for the model that is running.
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await expect.poll(async () => (await coreSessions(session.profile.dataFolder)).length, { timeout: 60_000 }).toBe(1)

      await browser.$('//*[normalize-space(text())="Integrations"]').click()
      await clickWhenStill(session, runButton)
      await pageShows(session, `${AGENT} configured`, 60_000)

      // The config now names the local API and the running model...
      const configured = await readFile(configPath, 'utf8')
      expect(configured).toContain(localApi)
      expect(configured).toContain(MODEL_ID)
      // ...and everything the user had written is still there, verbatim.
      expect(configured).toContain('approval_policy = "on-request"')
      expect(configured).toContain('[mcp_servers.my_tool]')
      expect(configured).toContain('args = ["--serve"]')

      // The server the config points at is up, though nobody started it by hand.
      const models = await fetch(`${localApi}/models`, { headers: { authorization: `Bearer ${LOCAL_API_KEY}` } })
      expect(models.status).toBe(200)

      // One terminal would have been opened, running the agent.
      await expect.poll(openedTerminals, { timeout: 15_000 }).toHaveLength(1)
      expect((await openedTerminals())[0]).toContain('codex')

      // A second run configures nothing new: as many managed blocks as before
      // (root keys at the top, the provider table at the bottom — TOML's order),
      // the user's settings once, the same lines in the same order.
      await clickWhenStill(session, runButton)
      await expect.poll(openedTerminals, { timeout: 60_000 }).toHaveLength(2)
      afterFirstRun = configured
      afterSecondRun = await readFile(configPath, 'utf8')
      const meaningful = (text: string) => text.split('\n').filter((line) => line.trim() !== '')
      expect(meaningful(afterSecondRun)).toEqual(meaningful(afterFirstRun))
      const managedBlocks = (text: string) => text.split('# >>> Atomic Chat (managed) >>>').length - 1
      expect(managedBlocks(afterFirstRun)).toBeGreaterThan(0)
      expect(managedBlocks(afterSecondRun)).toBe(managedBlocks(afterFirstRun))
    })
  })

  // Each run used to insert two more blank lines above the user's own settings.
  it('leaves the file byte for byte as it was on a second run', () => {
    expect(afterSecondRun).not.toBe('')
    expect(afterSecondRun).toBe(afterFirstRun)
  })
})
