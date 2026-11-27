import { createHash } from 'node:crypto'
import {
  installMcpServer,
  MCP_SERVER_NAME,
  MCP_TOOL,
} from '../harness/mcp-server.js'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import {
  answerNextDialog,
  installFakeBackend,
  writeFakeModel,
} from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import {
  endSession,
  restartApp,
  startSession,
  withArtifacts,
  type Session,
} from '../harness/session.js'

const model = 'e2e/pi-tools'
const filename = 'agent-fixture.txt'
const contents = 'Written after approval'
const task = 'Create the workspace fixture'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('bundled pi Agent thread', () => {
  let session: Session
  let cwd: string

  beforeAll(async () => {
    session = await startSession('pi-thread', {
      prepare: async (profile) => {
        cwd = join(profile.home, 'pi-workspace')
        await mkdir(cwd)
        await installFakeBackend(profile, {
          reply: 'Fixture finished',
          toolCall: {
            name: 'write',
            arguments: { path: filename, content: contents },
          },
        })
        await writeFakeModel(profile, model, { tools: true })
      },
      webviewSeed: {
        '@janhq/llamacpp-upstream-extension': JSON.stringify([
          { key: 'fit', controllerProps: { value: false } },
          { key: 'ctx_len', controllerProps: { value: 32768 } },
        ]),
      },
    })
  })
  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('chooses a workspace, approves a write, and reopens its persisted conversation', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      await pickModel(session, model)
      const pageCenterOffset = await browser.execute(() => {
        const group = Array.from(
          document.querySelectorAll('button[aria-pressed]')
        )
          .find((button) => button.textContent?.trim() === 'Agent')
          ?.closest('[role="group"]')
        const page = group?.closest('main')
        if (!group || !page || group.closest('[data-window-titlebar]'))
          return null
        const a = group.getBoundingClientRect(),
          b = page.getBoundingClientRect()
        return Math.abs(a.left + a.width / 2 - b.left - b.width / 2)
      })
      expect(pageCenterOffset).not.toBeNull()
      expect(pageCenterOffset).toBeLessThan(2)
      await browser
        .$('//button[@aria-pressed="false" and normalize-space(.)="Agent"]')
        .click()
      await answerNextDialog(session.profile, cwd)
      await browser.$('//button[normalize-space(.)="Choose workspace"]').click()
      await browser
        .$('[data-composer-anchor] button[title="' + cwd + '"]')
        .waitForDisplayed()
      await send(session, task)
      await browser.waitUntil(
        async () => {
          const alert = browser.$('[role="alert"]')
          if (await alert.isDisplayed()) throw new Error(await alert.getText())
          return browser
            .$('[data-testid="agent-approval-inline"]')
            .isDisplayed()
        },
        { timeout: 60000, timeoutMsg: 'The Agent approval card did not appear' }
      )
      expect(await readdir(cwd)).not.toContain(filename)
      await browser.$('//button[normalize-space(.)="Approve once"]').click()
      await expect
        .poll(() => readFile(join(cwd, filename), 'utf8').catch(() => ''), {
          timeout: 45000,
        })
        .toBe(contents)
      await pageShows(session, 'Fixture finished', 60000)
      await browser.$('button[aria-label="Open files sidebar"]').click()
      await pageShows(session, filename, 15000)
      const url = await browser.getUrl()
      expect(url).toMatch(/\/agent\/[^/?#]+/)
      const chatSwitch =
        '//button[@aria-pressed="false" and normalize-space(.)="Chat"]'
      expect(await browser.$(chatSwitch).isExisting()).toBe(false)
      expect(await browser.$('h1 button').isExisting()).toBe(false)
      await browser.$('//button[normalize-space(.)="New task"]').click()
      await browser.$(chatSwitch).click()
      expect(await browser.$('div[role=log]').isExisting()).toBe(false)
      await restartApp(session)
      await session.app.browser.url(url)
      await pageShows(session, task, 30000)
      await pageShows(session, 'Fixture finished', 30000)
      await send(session, '/name Resumed pi session')
      await pageShows(session, 'Resumed pi session', 30000)
    })
  }, 240000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)(
  'Atomic Chat integrations inside pi',
  () => {
    let session: Session
    let cwd: string
    let mcp: Awaited<ReturnType<typeof installMcpServer>>
    const skillName = 'record-lookup'
    const instruction = 'Follow the Atomic record lookup procedure.'
    beforeAll(async () => {
      session = await startSession('pi-integrations', {
        prepare: async (profile) => {
          cwd = join(profile.home, 'work')
          const skill = join(profile.dataFolder, 'agent-skills', skillName)
          await mkdir(cwd)
          await mkdir(skill, { recursive: true })
          await writeFile(
            join(skill, 'SKILL.md'),
            '---\nname: record-lookup\ndescription: Look up a test record\n---\n' +
              instruction
          )
          mcp = await installMcpServer(profile, {
            answer: 'Approved connector result',
          })
          const digest = createHash('sha256')
            .update(JSON.stringify([MCP_SERVER_NAME, MCP_TOOL]))
            .digest('hex')
            .slice(0, 12)
          await installFakeBackend(profile, {
            reply: 'Processed',
            toolCall: {
              name: 'mcp_e2e_records_e2e_lookup_record_' + digest,
              arguments: { code: 'PI-42' },
            },
          })
          await writeFakeModel(profile, model, { tools: true })
        },
        webviewSeed: {
          '@janhq/llamacpp-upstream-extension': JSON.stringify([
            { key: 'fit', controllerProps: { value: false } },
            { key: 'ctx_len', controllerProps: { value: 32768 } },
          ]),
        },
      })
    })
    afterAll(async () => {
      if (session) expect(await endSession(session)).toEqual([])
    })

    it('loads an enabled skill, asks permission, and returns a host MCP result to the model', async () => {
      await withArtifacts(session, async () => {
        const browser = session.app.browser
        await waitForChat(session)
        await pickModel(session, model)
        await browser
          .$('//button[@aria-pressed="false" and normalize-space(.)="Agent"]')
          .click()
        await answerNextDialog(session.profile, cwd)
        await browser
          .$('//button[normalize-space(.)="Choose workspace"]')
          .click()
        await browser
          .$('[data-composer-anchor] button[title="' + cwd + '"]')
          .waitForDisplayed()
        const tools = browser.$(
          '[data-composer-anchor] button[aria-label="Tools"]'
        )
        await tools.click()
        await browser
          .$('[data-testid="connector-name-' + MCP_SERVER_NAME + '"]')
          .waitForDisplayed()
        await browser.keys('Escape')
        await send(session, '/record-lookup look up PI-42')
        const root = join(session.profile.dataFolder, 'pi-agent')
        const catalog = async () => {
          const dir = (await readdir(root).catch(() => [])).find((dir) =>
            dir.startsWith('thread-')
          )
          if (!dir) return []
          const raw = await readFile(
            join(root, dir, 'integrations.json'),
            'utf8'
          ).catch(() => '{}')
          return JSON.parse(raw).tools ?? []
        }
        await expect.poll(catalog, { timeout: 12_000 }).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: MCP_TOOL,
              server: MCP_SERVER_NAME,
            }),
          ])
        )
        const card = browser.$('[data-testid="agent-approval-inline"]')
        await card.waitForDisplayed({ timeout: 60_000 })
        expect(await mcp.calls()).toEqual([])
        await browser
          .$(
            '//div[@data-testid="agent-approval-inline"]//button[normalize-space(.)="Approve once"]'
          )
          .click()
        await pageShows(session, 'Approved connector result for PI-42', 60_000)
        expect(await mcp.calls()).toMatchObject([
          { name: MCP_TOOL, arguments: { code: 'PI-42' } },
        ])
        const id = (await readdir(root)).find((dir) =>
          dir.startsWith('thread-')
        )!
        const sessions = join(root, id, 'sessions')
        const file = (await readdir(sessions)).find((file) =>
          file.endsWith('.jsonl')
        )!
        expect(await readFile(join(sessions, file), 'utf8')).toContain(
          instruction
        )
      })
    }, 180_000)
  }
)
