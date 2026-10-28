/**
 * All integrations (Server → Overview) pointing a coding agent at the local API. "Run" does
 * three things for the user: starts the local server if it is down, writes the
 * agent's own config file so that it talks to that server, and opens a terminal
 * with the agent in it. The config lives in the user's home, next to settings
 * the user wrote themselves, so what matters most is what it leaves alone.
 *
 * The home is the profile's stand-in, `codex` is a stand-in on the app's PATH
 * that is never executed, and an e2e build writes down the terminal it would
 * have opened instead of opening one on the desktop of whoever runs the tests.
 *
 * ZCode is the other kind of agent: a desktop app that reads a provider file
 * the page writes under ZCode's own lock, and is then opened rather than run
 * in a terminal — an e2e build writes that down too.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clickWhenStill, coreSessions, pageShows, pickModel, waitForChat } from '../harness/chat.js'
import { writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'
import { openAllIntegrations } from '../harness/navigation.js'

const MODEL_ID = 'e2e/fake-model'
const AGENT = 'Codex CLI'
const LOCAL_API_KEY = 'e2e-local-api-key'

/** What the user already had in ~/.codex/config.toml, none of it Atomic Chat's business. */
const USERS_OWN_CONFIG = `model = "users-own-model"
approval_policy = "on-request"

[mcp_servers.my_tool]
command = "my-tool"
args = ["--serve"]
`

/** The same file after an earlier release had configured Codex: two `model` keys, so not TOML. */
const LEFT_BY_EARLIER_RELEASE = `# >>> Atomic Chat (managed) >>>
model = "old-model"
model_provider = "atomic"
# <<< Atomic Chat (managed) <<<

${USERS_OWN_CONFIG}# >>> Atomic Chat (managed) >>>
[model_providers.atomic]
name = "Atomic Chat"
base_url = "http://127.0.0.1:1337/v1"
# <<< Atomic Chat (managed) <<<
`

const runButton = `//*[normalize-space(text())="${AGENT}"]/ancestor::*[.//button[normalize-space(.)="Run"]][1]//button[normalize-space(.)="Run"]`

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('running a coding agent from the Integrations page', () => {
  let session: Session
  let configPath = ''
  let profilePath = ''
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
        await writeFile(join(profile.home, '.codex', 'config.toml'), LEFT_BY_EARLIER_RELEASE)
      },
    })
    configPath = join(session.profile.home, '.codex', 'config.toml')
    profilePath = join(session.profile.home, '.codex', 'atomic-chat.config.toml')
    terminalsPath = join(session.profile.root, 'opened-terminals.jsonl')
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it("gives the user's config.toml back as they wrote it, with a backup of what was there", async () => {
    // The start has already repaired it: the user's own text, byte for byte.
    await expect.poll(() => readFile(configPath, 'utf8'), { timeout: 30_000 }).toBe(USERS_OWN_CONFIG)
    expect(await readFile(`${configPath}.atomic-chat-backup`, 'utf8')).toBe(LEFT_BY_EARLIER_RELEASE)
    // ...and what the earlier release pointed Codex at moved into our profile.
    const carried = await readFile(profilePath, 'utf8')
    expect(carried).toContain('model = "old-model"')
    expect(carried).toContain('model_provider = "atomic-chat"')
  })

  it('points the agent at the local API through its own profile, and does the same thing twice', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const localApi = `http://127.0.0.1:${session.apiPort}/v1`

      // The agent is configured for the model that is running.
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await expect.poll(async () => (await coreSessions(session.profile.dataFolder)).length, { timeout: 60_000 }).toBe(1)

      await openAllIntegrations(browser)
      await clickWhenStill(session, runButton)
      await pageShows(session, `${AGENT} configured`, 60_000)

      // The profile names the local API, the running model and the key's variable...
      const configured = await readFile(profilePath, 'utf8')
      expect(configured).toContain(`base_url = "${localApi}"`)
      expect(configured).toContain(`model = "${MODEL_ID}"`)
      expect(configured).toContain('env_key = "ATOMIC_CHAT_API_KEY"')
      expect(configured).not.toContain(LOCAL_API_KEY)
      // ...and the shared config is still exactly the user's.
      expect(await readFile(configPath, 'utf8')).toBe(USERS_OWN_CONFIG)

      // The server the profile points at is up, though nobody started it by hand.
      const models = await fetch(`${localApi}/models`, { headers: { authorization: `Bearer ${LOCAL_API_KEY}` } })
      expect(models.status).toBe(200)

      // One terminal would have been opened, running the agent on our profile with the key.
      await expect.poll(openedTerminals, { timeout: 15_000 }).toHaveLength(1)
      expect((await openedTerminals())[0]).toMatch(
        new RegExp(`^ATOMIC_CHAT_API_KEY='${LOCAL_API_KEY}' \\S*codex'? --profile atomic-chat$`)
      )

      // A second run rewrites only our profile, to the same bytes.
      await clickWhenStill(session, runButton)
      await expect.poll(openedTerminals, { timeout: 60_000 }).toHaveLength(2)
      afterFirstRun = configured
      afterSecondRun = await readFile(profilePath, 'utf8')
      expect(await readFile(configPath, 'utf8')).toBe(USERS_OWN_CONFIG)
    })
  })

  it('leaves the profile byte for byte as it was on a second run', () => {
    expect(afterSecondRun).not.toBe('')
    expect(afterSecondRun).toBe(afterFirstRun)
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('running ZCode from the Integrations page', () => {
  const ZCODE = 'ZCode'
  const zcodeRun = `//*[normalize-space(text())="${ZCODE}"]/ancestor::*[.//button[normalize-space(.)="Run"]][1]//button[normalize-space(.)="Run"]`
  /** The user's own provider, which must survive untouched. */
  const THEIRS = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: 'their-provider',
            providerName: 'Theirs',
            enabled: true,
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: 'sk-theirs' },
              api: { type: 'openai-chat-completions', baseUrl: 'https://example.test/v1', headers: null },
              personalModelIds: ['their-model'],
              modelOrder: ['their-model'],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }
  let session: Session
  let providerFile = ''
  let terminalsPath = ''

  const openedTerminals = async (): Promise<string[]> =>
    (await readFile(terminalsPath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)

  beforeAll(async () => {
    session = await startSession('launch-zcode', {
      apiServer: { apiKey: LOCAL_API_KEY },
      prepare: async (profile) => {
        await writeFakeModel(profile, MODEL_ID)
        await writeFile(join(profile.binDir, 'zcode'), '#!/bin/sh\nexit 0\n')
        await chmod(join(profile.binDir, 'zcode'), 0o755)
        await mkdir(join(profile.home, '.zcode', 'v2'), { recursive: true })
        await writeFile(join(profile.home, '.zcode', 'v2', 'provider_config.json'), JSON.stringify(THEIRS, null, 2))
      },
    })
    providerFile = join(session.profile.home, '.zcode', 'v2', 'provider_config.json')
    terminalsPath = join(session.profile.root, 'opened-terminals.jsonl')
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it("writes ZCode's provider file for the running model, keeps the user's own provider, and does it the same way twice", async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const localApi = `http://127.0.0.1:${session.apiPort}/v1`
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await expect.poll(async () => (await coreSessions(session.profile.dataFolder)).length, { timeout: 60_000 }).toBe(1)

      await openAllIntegrations(browser)
      await clickWhenStill(session, zcodeRun)
      await pageShows(session, `${ZCODE} configured`, 60_000)

      const written = JSON.parse(await readFile(providerFile, 'utf8')) as {
        schemaVersion: number
        config: {
          providerConfigRules: { providerRules: Array<{ providerId: string; config: Record<string, unknown> }> }
          modelConfigRules: { providerModelRules: Array<{ providerId: string; modelId: string; config: { properties: { contextWindow: number } } }> }
        }
      }
      expect(written.schemaVersion).toBe(1)
      const rules = written.config.providerConfigRules.providerRules
      expect(rules.map((rule) => rule.providerId)).toEqual(['their-provider', 'atomic-chat'])
      expect(rules[0]?.config).toEqual(THEIRS.config.providerConfigRules.providerRules[0]?.config)
      expect(rules[1]?.config).toMatchObject({
        api: { type: 'openai-chat-completions', baseUrl: localApi },
        access: { apiKey: LOCAL_API_KEY },
        personalModelIds: [MODEL_ID],
      })
      expect(written.config.modelConfigRules.providerModelRules).toEqual([
        expect.objectContaining({
          providerId: 'atomic-chat',
          modelId: MODEL_ID,
          config: expect.objectContaining({ properties: expect.objectContaining({ contextWindow: 65536 }) }),
        }),
      ])
      // The pre-Atomic file is kept once; ZCode's lock is not left behind.
      expect(JSON.parse(await readFile(`${providerFile}.atomic-backup`, 'utf8'))).toEqual(THEIRS)
      expect(await stat(`${providerFile}.lock`).catch(() => null)).toBeNull()
      // ZCode itself would have been opened, once.
      await expect.poll(openedTerminals, { timeout: 15_000 }).toHaveLength(1)
      expect((await openedTerminals())[0]).toContain('zcode')

      const first = await readFile(providerFile, 'utf8')
      await clickWhenStill(session, zcodeRun)
      await expect.poll(openedTerminals, { timeout: 60_000 }).toHaveLength(2)
      expect(await readFile(providerFile, 'utf8')).toBe(first)
      expect(JSON.parse(await readFile(`${providerFile}.atomic-backup`, 'utf8'))).toEqual(THEIRS)
    })
  }, 300_000)
})
