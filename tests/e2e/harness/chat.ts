/**
 * The steps and observations the chat scenarios share: what a user does to talk
 * to a local model, and what the core says about the sessions behind it.
 */
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import { coreRequest } from './core.js'
import { spawnedArgvPath } from './fixtures.js'
import { listProcesses } from './platform.js'
import type { Profile } from './profile.js'
import type { Session } from './session.js'

export const CHAT_INPUT = '[data-testid="chat-input"]'

export interface LocalSession {
  pid: number
  port: number
  model_id: string
  api_key: string
}

export async function coreSessions(dataFolder: string): Promise<LocalSession[]> {
  const response = await coreRequest(dataFolder, '/sessions')
  expect(response.status).toBe(200)
  return ((await response.json()) as { sessions: LocalSession[] }).sessions
}

export async function pageText(session: Session): Promise<string> {
  return session.app.browser.$('body').getText()
}

/** How many times `text` is on the page — a second reply repeats the first one's text. */
export async function occurrences(session: Session, text: string): Promise<number> {
  return (await pageText(session)).split(text).length - 1
}

export async function pageShows(
  session: Session,
  text: string,
  timeout: number,
  atLeast = 1
): Promise<void> {
  await session.app.browser.waitUntil(async () => (await occurrences(session, text)) >= atLeast, {
    timeout,
    timeoutMsg: `the page never showed "${text}" ${atLeast} time(s)`,
  })
}

export async function waitForChat(session: Session): Promise<void> {
  // A profile that already holds a usable local model skips onboarding.
  await session.app.browser.$(CHAT_INPUT).waitForDisplayed({ timeout: 60_000 })
}

/**
 * Picks a model in the composer's picker. With nothing selected the picker
 * opens straight on the model list; with a model selected it opens on a summary
 * whose "Change model" button leads there. A model shows once per active
 * provider: on a fresh profile only the upstream llama.cpp provider is active,
 * though both llama.cpp providers share the models folder. The row is the
 * `button`; the `span` inside it repeats the title, which is why the tag is
 * named rather than matching on the attribute alone. The trigger carries the
 * selected model's id as its own title, so it has to be excluded: otherwise the
 * row appears to still be there once the popover has closed over it.
 */
export async function pickModel(session: Session, modelId: string, provider?: string): Promise<void> {
  const browser = session.app.browser
  const trigger = browser.$('[data-test-id="model-picker-trigger"]')
  const change = browser.$('button[aria-label="Change model"]')
  // Both llama.cpp providers list the same model folder, so with both enabled a
  // model has a row under each; a provider narrows the pick to its group, which
  // is the block around that provider's settings gear.
  const rowSelector = provider
    ? `//*[@data-test-id="provider-settings-${provider}"]/../..//button[@title="${modelId}" and not(@data-test-id)]`
    : `button[title="${modelId}"]:not([data-test-id="model-picker-trigger"])`
  const row = browser.$(rowSelector)
  // Queried afresh on every look: a `$$` result is resolved once and then
  // keeps answering with what it found the first time.
  const rowCount = () => browser.$$(rowSelector).length
  const shows = async (element: typeof row) => (await element.isExisting()) && (await element.isDisplayed())

  // Open it, and make sure it stayed open. A page that is still settling — a
  // thread route restoring its model, for one — can close the popover right
  // after it opens, leaving its content in the DOM but out of sight. Clicking
  // the trigger again is safe here: it is only done while nothing is showing.
  // Which of the two views it opened on is known once it has rendered one.
  await browser.waitUntil(
    async () => {
      if ((await shows(change)) || (await shows(row))) return true
      await trigger.click()
      return false
    },
    { timeout: 30_000, interval: 1_500, timeoutMsg: 'the model picker did not open' }
  )
  if (!(await shows(row))) await change.click()
  await expect.poll(rowCount, { timeout: 15_000 }).toBe(1)

  // The outcome is read off the trigger, which shows the selected model. The
  // row itself says nothing: it stays in the DOM while the popover animates
  // shut, and clicking it again then reopens the picker.
  //
  // Read from the trigger's title rather than its text: the text is a display name the app makes
  // of the id — `e2e/fake-mlx-model` is offered as "Fake Model" — while the title is the id
  // itself, which is what the scenario asked for.
  const picked = () =>
    browser
      .waitUntil(async () => (await trigger.getAttribute('title')) === modelId, { timeout: 5_000 })
      .then(() => true, () => false)

  await row.waitForClickable({ timeout: 15_000 })
  await row.click()
  if (!(await picked())) {
    // A click that landed while the popover was still animating open.
    if (await row.isDisplayed()) await row.click()
    expect(await picked(), `the picker never showed ${modelId} as selected`).toBe(true)
  }
  // The popover hands focus back to its trigger as it closes; a keystroke sent
  // before then misses the composer.
  await row.waitForExist({ reverse: true, timeout: 10_000 })
}

/**
 * Types a message and sends it the way a person can: only once the send button
 * is enabled. While a local model is loading — after it was picked, or while
 * the app restarts a backend that crashed — the composer disables the button
 * and ignores Enter, leaving the text in the field.
 */
export async function send(session: Session, prompt: string): Promise<void> {
  const browser = session.app.browser
  const input = browser.$(CHAT_INPUT)
  await input.click()
  await input.setValue(prompt)
  await browser.$('[data-test-id="send-message-button"]').waitForEnabled({ timeout: 60_000 })
  // Enter goes to whatever holds focus, and a closing popover or a finished
  // model load can take it away while the button was being waited for.
  await browser.waitUntil(
    async () => {
      if (await input.isFocused()) return true
      await input.click()
      return false
    },
    { timeout: 10_000, timeoutMsg: 'the chat input never kept focus' }
  )
  await browser.keys('Enter')
  // Sent means the composer is empty again; text left behind means the
  // keystroke was dropped, which would otherwise surface as a missing reply.
  await browser.waitUntil(async () => (await input.getValue()) === '', {
    timeout: 10_000,
    timeoutMsg: `"${prompt}" was typed but not sent`,
  })
}

/** Opens a local provider's settings page the way a user does: the gear beside it in the model picker. */
export async function openProviderSettings(session: Session, provider: string): Promise<void> {
  const browser = session.app.browser
  await browser.$('[data-test-id="model-picker-trigger"]').click()
  const change = browser.$('button[aria-label="Change model"]')
  const gear = browser.$(`[data-test-id="provider-settings-${provider}"]`)
  await browser.waitUntil(async () => (await change.isExisting()) || (await gear.isExisting()), {
    timeout: 15_000,
    timeoutMsg: 'the model picker did not open',
  })
  if (!(await gear.isExisting())) await change.click()
  await gear.waitForClickable({ timeout: 15_000 })
  await gear.click()
}

/**
 * Clicks an element once it has stopped moving. Pages that fill in as results
 * arrive — the Integrations page resolves each agent's status separately — shift
 * their layout under a click aimed a moment earlier, and the click lands on
 * nothing. Clicking again is not an answer where the action must happen once.
 */
export async function clickWhenStill(session: Session, selector: string): Promise<void> {
  const browser = session.app.browser
  const element = browser.$(selector)
  await element.waitForClickable({ timeout: 30_000 })
  let last = ''
  let stableFor = 0
  await browser.waitUntil(
    async () => {
      const { x, y } = await element.getLocation()
      const now = `${Math.round(x)},${Math.round(y)}`
      stableFor = now === last ? stableFor + 1 : 0
      last = now
      return stableFor >= 3
    },
    { timeout: 30_000, interval: 300, timeoutMsg: `${selector} never stopped moving` }
  )
  await element.click()
}

/**
 * Chooses an item from a dropdown menu, from the keyboard. These menus open on
 * `pointerdown`, which the embedded WebDriver's click does not produce; Enter on
 * the focused trigger opens them the way it does for a user without a mouse.
 * The trigger only has to exist: a thread row's is drawn on hover or on focus,
 * and focus is what this gives it.
 */
export async function chooseFromMenu(session: Session, trigger: string, item: string): Promise<void> {
  const browser = session.app.browser
  const button = browser.$(trigger)
  await button.waitForExist({ timeout: 15_000 })
  const entry = browser.$(`//*[@role="menuitem"][starts-with(normalize-space(.), "${item}")]`)
  // Opened again only while it is shut: focus can be taken from the trigger
  // between the two steps (a finishing reply returns it to the composer), and
  // Enter then goes elsewhere. A second Enter on an open menu would pick from it.
  await browser.waitUntil(
    async () => {
      if ((await entry.isExisting()) && (await entry.isDisplayed())) return true
      await browser.execute((el) => (el as unknown as HTMLElement).focus(), await button)
      await browser.keys('Enter')
      return false
    },
    { timeout: 20_000, interval: 1_500, timeoutMsg: `the menu never offered "${item}"` }
  )
  await browser.execute((el) => (el as unknown as HTMLElement).focus(), await entry)
  await browser.keys('Enter')
  await entry.waitForExist({ reverse: true, timeout: 10_000 })
}

/**
 * What every report of a dead model process says, whichever title it carries:
 * "Model crashed during generation" while a reply was being produced, "Model
 * stopped unexpectedly" otherwise.
 */
export const CRASH_TOAST = "The model's backend process exited unexpectedly"
export const IDLE_CRASH_TITLE = 'Model stopped unexpectedly'

/**
 * Watches the page for a text that may come and go, such as a toast, which a
 * single look afterwards would miss. `stop()` returns how many samples saw it.
 */
export function watchFor(session: Session, text: string): { stop: () => Promise<number> } {
  let running = true
  let sightings = 0
  const loop = (async () => {
    while (running) {
      if ((await pageText(session).catch(() => '')).includes(text)) sightings += 1
      await new Promise((r) => setTimeout(r, 150))
    }
  })()
  const stop = async () => {
    running = false
    await loop
    return sightings
  }
  session.watchers.push(stop)
  return { stop }
}

/** Fake backends still alive under this profile, found by their own argv. */
export function liveFakeBackends(dataFolder: string): number[] {
  return listProcesses()
    .filter((p) => p.command.includes('fake-llama-server') && p.command.includes(dataFolder))
    .map((p) => p.pid)
}

/** Command lines of the fake backends alive under this profile: the argv the core chose. */
export function fakeBackendCommands(dataFolder: string): string[] {
  return listProcesses()
    .filter((p) => p.command.includes('fake-llama-server') && p.command.includes(dataFolder))
    .map((p) => p.command)
}

/** One start of a fake backend, as the backend itself recorded it. */
export interface SpawnedBackend {
  pid: number
  atMs: number
  /** `<provider>:<version>/<backend>` of the pack that launched it. */
  label: string
  exe: string
  argv: string[]
  /** The inference-relevant environment only; `PATH` and the rest are not recorded. */
  env: Record<string, string>
}

/**
 * Every fake backend this profile has started, oldest first — including the ones that have since
 * exited, which is the difference from `fakeBackendCommands`. A scenario that changes a setting and
 * loads a model reads the last record to see the argv the core built from it.
 */
export function spawnedBackends(profile: Profile): SpawnedBackend[] {
  let raw: string
  try {
    raw = readFileSync(spawnedArgvPath(profile), 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SpawnedBackend)
    .sort((a, b) => a.atMs - b.atMs)
}

/** The starts that loaded this model, oldest first: its path is in the argv the core built. */
export function spawnedFor(profile: Profile, modelId: string): SpawnedBackend[] {
  return spawnedBackends(profile).filter((start) =>
    start.argv.some((argument) => argument.includes(`/${modelId}/`))
  )
}

/**
 * The argv of the last start of this model. Fails with what was recorded instead of returning
 * undefined, because "no record" almost always means the neighbouring core checkout predates
 * `argvFile` rather than that the model never loaded.
 */
export function lastArgvFor(profile: Profile, modelId: string): string[] {
  const starts = spawnedFor(profile, modelId)
  const last = starts[starts.length - 1]
  if (!last) {
    const seen = spawnedBackends(profile).map((start) => start.label)
    throw new Error(
      `no backend start recorded for ${modelId}; recorded starts: ${JSON.stringify(seen)}. ` +
        'If this is empty, the atomic-chat-core checkout may not support argvFile yet.'
    )
  }
  return last.argv
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
