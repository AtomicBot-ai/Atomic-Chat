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

/** Starts a new chat from the Workspace sidebar, wherever the app is. */
export async function startNewChat(browser: Browser): Promise<void> {
  await openSection(browser, 'chat')
  await openSidebarRow(browser, 'New Chat')
}
