/**
 * First launch on a clean install: the packaged UI, the real IPC and the real
 * storage on both sides — the app configuration Rust writes and the onboarding
 * state the webview keeps — have to agree across a full restart.
 */
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appEnv, invoke, spawnApp } from '../harness/app.js'
import { homeRedirect } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'

const ONBOARDING_HEADING = 'h1=Welcome to Atomic Chat!'
const CHAT_INPUT = '[data-testid="chat-input"]'

describe('first launch on a clean profile', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('onboarding')
  })

  afterAll(async () => {
    // If the operator's own Atomic Chat ran during the test, its writes show
    // up here too; the message names the path to check.
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('offers onboarding, lets the user skip it, and stays skipped after a restart', async () => {
    await withArtifacts(session, async () => {
      let browser = session.app.browser

      // No model anywhere — the data folder is empty and so is the home the
      // local-model scan looks through — so the first screen is onboarding.
      await browser.$(ONBOARDING_HEADING).waitForDisplayed({ timeout: 60_000 })

      // The profile is the run's own on both sides of the IPC boundary.
      const config = await invoke<{ data_folder: string }>(browser, 'get_app_configurations')
      expect(config.data_folder).toBe(session.profile.dataFolder)
      const onDisk = JSON.parse(await readFile(join(session.profile.root, 'settings.json'), 'utf8'))
      expect(onDisk.data_folder).toBe(session.profile.dataFolder)

      // The seed reached the webview before its stores rehydrated: the local
      // API server is neither auto-started nor pointed at the operator's 1337.
      const apiServer = await browser.execute(
        () => JSON.parse(localStorage.getItem('setting-local-api-server') ?? '{}').state
      )
      expect(apiServer).toMatchObject({ enableOnStartup: false, serverPort: session.apiPort })

      await browser.$('button=Skip').click()
      await browser.$(CHAT_INPUT).waitForDisplayed({ timeout: 30_000 })
      expect(await browser.$(ONBOARDING_HEADING).isExisting()).toBe(false)

      await restartApp(session)
      browser = session.app.browser

      // Skipping was remembered by the webview's own storage, which the restart
      // kept because the WebKit store belongs to the profile, not to the process.
      await browser.$(CHAT_INPUT).waitForDisplayed({ timeout: 60_000 })
      expect(await browser.$(ONBOARDING_HEADING).isExisting()).toBe(false)
      expect(await browser.execute(() => localStorage.getItem('setup-completed'))).toBe('true')
    })
  })
})

describe('an end-to-end build without a root of its own', () => {
  it('exits with code 2 before it reads or writes anything', async () => {
    // Even the refusal runs with a throwaway home, in case it ever regresses.
    const home = await realpath(await mkdtemp(join(tmpdir(), 'atomic-refusal-')))
    try {
      const { child, output } = spawnApp(appEnv({ ...homeRedirect(home), TAURI_WEBDRIVER_PORT: '1' }))
      const [code] = (await once(child, 'exit')) as [number | null]

      expect(code).toBe(2)
      expect(output()).toContain('ATOMIC_E2E_DATA_ROOT is not set')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
