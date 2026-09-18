/**
 * A provider setting changed in the UI has three homes that must agree: the
 * webview, where the extension keeps it; the core, which owns the runtime since
 * the migration and receives the value from the extension; and the argv of the
 * backend the core spawns next. The setting used is "Fit context to device
 * memory": it is a plain switch, and it shows up in argv as `--fit off`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeBackendCommands, pickModel, waitForChat } from '../harness/chat.js'
import { FAKE_PROVIDER, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'

const FIRST_MODEL = 'e2e/model-one'
const SECOND_MODEL = 'e2e/model-two'
const FIT_TITLE = 'Fit context to device memory'

/** The switch in the settings row whose title a user reads. */
const FIT_SWITCH = `//*[normalize-space(text())="${FIT_TITLE}"]/ancestor::*[.//button[@role="switch"]][1]//button[@role="switch"]`

async function coreFit(dataFolder: string): Promise<{ fit: unknown; revision: number }> {
  const settings = JSON.parse(await readFile(join(dataFolder, 'atomic-core', 'settings.json'), 'utf8')) as {
    revision: number
    providers?: Record<string, Record<string, unknown>>
  }
  return { fit: settings.providers?.[FAKE_PROVIDER]?.fit, revision: settings.revision }
}

async function openProviderSettings(session: Session): Promise<void> {
  const browser = session.app.browser
  await browser.$('[data-test-id="model-picker-trigger"]').click()
  const change = browser.$('button[aria-label="Change model"]')
  const gear = browser.$(`[data-test-id="provider-settings-${FAKE_PROVIDER}"]`)
  await browser.waitUntil(async () => (await change.isExisting()) || (await gear.isExisting()), {
    timeout: 15_000,
    timeoutMsg: 'the model picker did not open',
  })
  if (!(await gear.isExisting())) await change.click()
  await gear.waitForClickable({ timeout: 15_000 })
  await gear.click()
  await browser.$(FIT_SWITCH).waitForDisplayed({ timeout: 30_000 })
}

const fitArgs = (dataFolder: string): string[] =>
  fakeBackendCommands(dataFolder).map((command) => /--fit (\S+)/.exec(command)?.[1] ?? 'absent')

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a provider setting changed in the UI', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('provider-settings', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: 'ATOMIC-E2E-SETTINGS 0b7d' })
        await writeFakeModel(profile, FIRST_MODEL)
        await writeFakeModel(profile, SECOND_MODEL)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('reaches the core and the next backend, survives a restart, and can be turned back', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      let browser = session.app.browser
      await waitForChat(session)

      // As shipped the engine fits the context itself.
      await openProviderSettings(session)
      expect(await browser.$(FIT_SWITCH).getAttribute('aria-checked')).toBe('true')

      await browser.$(FIT_SWITCH).click()
      await expect.poll(() => browser.$(FIT_SWITCH).getAttribute('aria-checked')).toBe('false')

      // The next load carries it: the core was told, and told the backend.
      await browser.$('//*[normalize-space(text())="New Chat"]').click()
      await waitForChat(session)
      await pickModel(session, FIRST_MODEL)
      await expect.poll(() => fitArgs(dataFolder), { timeout: 60_000 }).toEqual(['off'])
      const afterOff = await coreFit(dataFolder)
      expect(afterOff.fit).toBe(false)

      await restartApp(session)
      browser = session.app.browser
      await waitForChat(session)

      // Both sides kept it: the switch the user sees, and the core's own file.
      await openProviderSettings(session)
      expect(await browser.$(FIT_SWITCH).getAttribute('aria-checked')).toBe('false')
      expect((await coreFit(dataFolder)).fit).toBe(false)

      // Turning it back is a new revision in the core, and the next backend —
      // the other model, so that something has to be spawned — runs without
      // the override.
      await browser.$(FIT_SWITCH).click()
      await expect.poll(() => browser.$(FIT_SWITCH).getAttribute('aria-checked')).toBe('true')
      await browser.$('//*[normalize-space(text())="New Chat"]').click()
      await waitForChat(session)
      await pickModel(session, SECOND_MODEL)
      await expect.poll(() => fitArgs(dataFolder), { timeout: 60_000 }).not.toContain('off')
      const afterOn = await coreFit(dataFolder)
      expect(afterOn.fit).toBe(true)
      expect(afterOn.revision).toBeGreaterThan(afterOff.revision)
    })
  })
})
