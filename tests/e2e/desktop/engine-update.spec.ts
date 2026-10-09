/**
 * Engine versions and updates through the core (change `unify-engine-lifecycle`, task 6.9): the
 * desktop takes every offer from `POST /engines/versions`, applies it with `POST /engines/:e/update`,
 * switches and removes builds with the core's commands, and mirrors the `version_backend` the core
 * writes.
 *
 *   - the llama.cpp build the installer brings is listed as `bundled` and cannot be removed — the
 *     location contract of design D4 (`<resources>/llamacpp-backend-upstream` beside `--resources-dir`);
 *   - a newer release behind the user's proxy is offered in the banner, and "Update" has the core
 *     install it, switch to it and unload the model that ran on the old one; the old build stays;
 *   - "Make active" on another installed build switches to it, and the version dropdown follows;
 *   - "Remove" on an inactive build deletes it after the confirmation.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proxySeed, startBackendMirror, type BackendMirror } from '../harness/backend-mirror.js'
import { coreSessions, openProviderSettings, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { FAKE_BACKEND, FAKE_PROVIDER, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { bundledBackends, endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const OLD_TAG = 'b99990'
const OLDER_TAG = 'b99980'
const NEW_TAG = 'b99999'
const OLD_REPLY = 'ATOMIC-E2E-OLD-BACKEND 51c2'
const NEW_REPLY = 'ATOMIC-E2E-NEW-BACKEND 7a90'
const BANNER = '[data-testid="engine-update-banner"]'
const BUILDS = `[data-testid="engine-builds-${FAKE_PROVIDER}"]`

interface Entry {
  engine: string
  active: { version: string; variant: string } | null
  builds: Array<{ version: string; variant: string; origin: string; active: boolean; removable: boolean }>
}

/** The core's own answer about the upstream llama.cpp provider. */
async function upstreamVersions(dataFolder: string): Promise<Entry> {
  const res = await coreRequest(dataFolder, '/engines/versions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  expect(res.status).toBe(200)
  const { engines } = (await res.json()) as { engines: Entry[] }
  return engines.find((entry) => entry.engine === FAKE_PROVIDER) as Entry
}

async function coreVersionBackend(dataFolder: string): Promise<unknown> {
  const settings = JSON.parse(await readFile(join(dataFolder, 'atomic-core', 'settings.json'), 'utf8')) as {
    providers?: Record<string, Record<string, unknown>>
  }
  return settings.providers?.[FAKE_PROVIDER]?.version_backend
}

const onDisk = (dataFolder: string, tag: string) =>
  stat(join(dataFolder, FAKE_PROVIDER, 'backends', tag, FAKE_BACKEND, 'build', 'bin', 'llama-server')).then(
    () => true,
    () => false
  )

/** The tag of the installer's upstream build, when this dev machine fetched one. */
const BUNDLED_TAG = bundledBackends()
  .find((entry) => entry.startsWith(`${FAKE_PROVIDER}:`))
  ?.split(':')[1]
  ?.split('/')[0]

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('switching and removing installed llama.cpp builds', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('engine-builds', {
      backendVersion: OLD_TAG,
      alsoAllowedBackends: [`${FAKE_PROVIDER}:${OLDER_TAG}/${FAKE_BACKEND}`],
      prepare: async (profile) => {
        await installFakeBackend(profile, { version: OLD_TAG, reply: OLD_REPLY })
        await installFakeBackend(profile, { version: OLDER_TAG, reply: NEW_REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it.skipIf(BUNDLED_TAG === undefined)("lists the installer's build as bundled, with no way to remove it", async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      const entry = await upstreamVersions(session.profile.dataFolder)
      expect(entry.builds.find((build) => build.version === BUNDLED_TAG)).toMatchObject({
        origin: 'bundled',
        removable: false,
      })
      await openProviderSettings(session, FAKE_PROVIDER)
      const row = browser.$(`${BUILDS} [data-testid="engine-build-${BUNDLED_TAG}"]`)
      await row.waitForDisplayed({ timeout: 30_000 })
      expect(await row.getText()).toContain('comes with the app')
      expect(await row.$('button=Remove').isEnabled()).toBe(false)
    })
  })

  it('makes another build active while a model runs, and the version dropdown follows', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await browser.$('//*[normalize-space(text())="New Chat"]').click()
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'which backend are you')
      await pageShows(session, OLD_REPLY, 90_000)
      expect((await upstreamVersions(dataFolder)).active?.version).toBe(OLD_TAG)

      await openProviderSettings(session, FAKE_PROVIDER)
      const other = browser.$(`${BUILDS} [data-testid="engine-build-${OLDER_TAG}"]`)
      await other.waitForDisplayed({ timeout: 30_000 })
      const makeActive = other.$('button=Make active')
      await makeActive.waitForClickable({ timeout: 30_000 })
      await makeActive.click()

      // The core writes `version_backend`, unloads the model, and the page mirrors the switch.
      await expect.poll(() => coreVersionBackend(dataFolder), { timeout: 30_000 }).toBe(`${OLDER_TAG}/${FAKE_BACKEND}`)
      await expect.poll(() => coreSessions(dataFolder), { timeout: 30_000 }).toEqual([])
      await pageShows(session, `${OLDER_TAG}/${FAKE_BACKEND}`, 30_000)
      expect(await onDisk(dataFolder, OLD_TAG)).toBe(true)
    })
  })

  it('removes an inactive build after the confirmation', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const row = browser.$(`${BUILDS} [data-testid="engine-build-${OLD_TAG}"]`)
      await row.waitForDisplayed({ timeout: 30_000 })
      const remove = row.$('button=Remove')
      await remove.waitForClickable({ timeout: 30_000 })
      await remove.click()
      const confirm = browser.$('//*[@role="dialog"]//button[normalize-space(.)="Remove"]')
      await confirm.waitForClickable({ timeout: 15_000 })
      await confirm.click()

      await expect.poll(() => onDisk(dataFolder, OLD_TAG), { timeout: 30_000 }).toBe(false)
      await row.waitForDisplayed({ reverse: true, timeout: 30_000 })
      expect((await upstreamVersions(dataFolder)).builds.map((build) => build.version)).not.toContain(OLD_TAG)
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a llama.cpp update offered in the banner and applied by the core', () => {
  let session: Session
  let mirror: BackendMirror

  beforeAll(async () => {
    mirror = await startBackendMirror({ tag: NEW_TAG, reply: NEW_REPLY })
    session = await startSession('engine-update', {
      backendVersion: OLD_TAG,
      alsoAllowedBackends: [`${FAKE_PROVIDER}:${NEW_TAG}/${FAKE_BACKEND}`],
      webviewSeed: proxySeed(mirror.proxyUrl),
      prepare: async (profile) => {
        await installFakeBackend(profile, { version: OLD_TAG, reply: OLD_REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await mirror?.stop()
    expect(left).toEqual([])
  })

  it('installs the release, switches to it, unloads the model and keeps the old build', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'which backend are you')
      await pageShows(session, OLD_REPLY, 90_000)

      // Asked after the core is ready; nothing is installed before the user says so.
      const banner = browser.$(BANNER)
      await banner.waitForDisplayed({ timeout: 120_000, timeoutMsg: `no offer; the mirror saw ${JSON.stringify(mirror.seen())}` })
      expect(await banner.getText()).toContain(NEW_TAG)
      expect(await onDisk(dataFolder, NEW_TAG)).toBe(false)
      const update = banner.$('button=Update')
      await update.waitForClickable({ timeout: 30_000 })
      await update.click()

      await expect.poll(() => coreVersionBackend(dataFolder), { timeout: 120_000 }).toBe(`${NEW_TAG}/${FAKE_BACKEND}`)
      expect(await onDisk(dataFolder, NEW_TAG)).toBe(true)
      expect(await onDisk(dataFolder, OLD_TAG)).toBe(true)
      await expect.poll(() => coreSessions(dataFolder), { timeout: 30_000 }).toEqual([])
      await banner.waitForDisplayed({ reverse: true, timeout: 30_000 })

      // The archive came through the user's proxy, from the host the manifest names.
      expect(mirror.seen()).toContain('CONNECT mirror.atomic.invalid:443')

      // The next message loads the model again — from the new build.
      await browser.$('//*[normalize-space(text())="which backend are you"]').click()
      await waitForChat(session)
      await send(session, 'and now')
      await pageShows(session, NEW_REPLY, 90_000)
    })
  }, 360_000)
})
