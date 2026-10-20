/**
 * Getting around the app the way a user does: the navigation rail picks a
 * section (Workspace, Server, Models Hub, Settings) and its sidebar shows that
 * section's pages. The rail buttons are icons, so they are found by test id.
 */
import type { Browser } from 'webdriverio'

export type NavigationSection = 'chat' | 'server' | 'models' | 'settings'

/**
 * Picks a section in the rail. Each one opens on its first page: Workspace on
 * a new chat, Server on the API page, Models Hub on the Hub, Settings on
 * General.
 */
export async function openSection(browser: Browser, section: NavigationSection): Promise<void> {
  const link = browser.$(`[data-testid="rail-${section}"]`)
  await link.waitForClickable({ timeout: 30_000 })
  await link.click()
}

/**
 * Clicks a row of the open section's sidebar by its visible label. A row may
 * carry a trailing "New" badge, so the label only has to start the row's text.
 */
export async function openSidebarRow(browser: Browser, label: string): Promise<void> {
  const row = browser.$(`//*[@data-sidebar="menu-button"][starts-with(normalize-space(.), "${label}")]`)
  await row.waitForClickable({ timeout: 30_000 })
  await row.click()
}

/** Opens a page of the Server section by its sidebar label, wherever the app is. */
export async function openServerPage(browser: Browser, label: string): Promise<void> {
  await openSection(browser, 'server')
  await openSidebarRow(browser, label)
}

/** The Server sidebar's Start/Stop button; its label is what it would do. */
const SERVER_POWER = '[data-testid="server-panel-power"]'

/** Waits until the Server sidebar's power button offers `label`. */
export async function waitForServerPower(
  browser: Browser,
  label: 'Start' | 'Stop',
  timeout = 60_000
): Promise<void> {
  const power = browser.$(SERVER_POWER)
  await browser.waitUntil(async () => (await power.isExisting()) && (await power.getText()).trim() === label, {
    timeout,
    timeoutMsg: `the Server sidebar never offered ${label}`,
  })
}

/** Starts the Local API Server from the Server sidebar and waits until it runs. */
export async function startServerFromSidebar(browser: Browser): Promise<void> {
  await openSection(browser, 'server')
  await waitForServerPower(browser, 'Start', 30_000)
  await browser.$(SERVER_POWER).click()
  await waitForServerPower(browser, 'Stop')
}

/** Stops the Local API Server from the Server sidebar and waits until it has. */
export async function stopServerFromSidebar(browser: Browser): Promise<void> {
  await openSection(browser, 'server')
  await waitForServerPower(browser, 'Stop', 30_000)
  await browser.$(SERVER_POWER).click()
  await waitForServerPower(browser, 'Start', 30_000)
}

/** Opens Server → Connections from the link in the sidebar's server panel. */
export async function openServerConnections(browser: Browser): Promise<void> {
  await openSection(browser, 'server')
  const link = browser.$('[data-testid="server-panel-connections"]')
  await link.waitForClickable({ timeout: 30_000 })
  await link.click()
}

/** Opens All integrations (the agents' install and run page) from Server → Overview. */
export async function openAllIntegrations(browser: Browser): Promise<void> {
  await openServerPage(browser, 'Overview')
  const link = browser.$('[data-testid="server-all-integrations"]')
  await link.waitForClickable({ timeout: 30_000 })
  await link.click()
}

/** Opens Models Hub → Inference engines, the overview of every engine. */
export async function openInferenceEngines(browser: Browser): Promise<void> {
  await openSection(browser, 'models')
  await openSidebarRow(browser, 'Inference engines')
}

/** Opens an engine's own settings page from its card on the overview. */
export async function openEnginePage(browser: Browser, provider: string): Promise<void> {
  await openInferenceEngines(browser)
  const link = browser.$(`[data-testid="engine-row-${provider}"] a`)
  await link.waitForClickable({ timeout: 30_000 })
  await link.click()
}

/** Opens the media engine's settings, which unfold inside its card on the overview. */
export async function openMediaEngineSettings(browser: Browser): Promise<void> {
  await openInferenceEngines(browser)
  const card = browser.$('[data-testid="engine-row-sd-cpp"] button[aria-expanded]')
  await card.waitForClickable({ timeout: 30_000 })
  // The overview may still be open from an earlier step, card unfolded.
  if ((await card.getAttribute('aria-expanded')) !== 'true') await card.click()
  await browser.$('[data-testid="media-settings-panel"]').waitForDisplayed({ timeout: 30_000 })
}

/** Starts a new chat from the Workspace sidebar, wherever the app is. */
export async function startNewChat(browser: Browser): Promise<void> {
  await openSection(browser, 'chat')
  await openSidebarRow(browser, 'New Chat')
}
