/**
 * A tool from an MCP server, used in a chat. The app starts the server named in
 * its MCP configuration, offers the server's tool to the model, and — because a
 * tool acts on the user's behalf — asks before running it. The scripted chat
 * model's one move is to call that tool; what the user answers decides whether
 * the server ever hears about it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseFromMenu, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { installMcpServer, MCP_TOOL, type McpFixture } from '../harness/mcp-server.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-MCP 8e05'
const RECORD = 'MCP-RECORD 51ae'
const CODE = 'K-204'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('an MCP tool in a chat', () => {
  let session: Session
  let mcp: McpFixture

  beforeAll(async () => {
    session = await startSession('mcp-tool', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY, toolCall: { name: MCP_TOOL, arguments: { code: CODE } } })
        await writeFakeModel(profile, MODEL_ID, { tools: true })
        mcp = await installMcpServer(profile, { answer: RECORD })
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  const APPROVAL_SELECT = 'button[aria-label="Ask for approval"]'
  const newChat = async () => {
    await session.app.browser.$('//*[normalize-space(text())="New Chat"]').click()
    await waitForChat(session)
  }

  it('is offered to the model and its result reaches the model', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, `look up record ${CODE}`)

      // The server was started by the app, the model called its tool with the
      // arguments it chose, and what the tool answered came back to the model.
      await pageShows(session, `${RECORD} for ${CODE}`, 60_000)
      const calls = await mcp.calls()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ name: MCP_TOOL, arguments: { code: CODE } })

      // It ran without a question. On a thread whose approval mode the user has
      // not touched, MCP tools follow the global "Allow all MCP permissions"
      // switch, which is on by default — while the composer's select for that
      // same thread reads "Ask for approval". Both halves are pinned here: the
      // label and the behaviour disagree, and whichever is changed to agree with
      // the other, this is where it shows.
      expect(await pageShows(session, 'Tool Approval Required', 1_000).then(() => true, () => false)).toBe(false)
      expect(await browser.$(APPROVAL_SELECT).isDisplayed()).toBe(true)
    })
  }, 300_000)

  it('waits for the user once they have chosen to be asked, and a refusal keeps the call from the server', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const before = (await mcp.calls()).length

      await newChat()
      await chooseFromMenu(session, APPROVAL_SELECT, 'Ask for approval')
      await send(session, `look up record ${CODE} again`)
      await pageShows(session, 'Tool Approval Required', 60_000)
      expect((await browser.$('body').getText())).toContain(MCP_TOOL)
      expect((await mcp.calls()).length).toBe(before)
      await browser.$('//button[normalize-space(.)="Deny"]').click()
      await browser.$('[data-test-id="send-message-button"]').waitForDisplayed({ timeout: 60_000 })
      await browser.pause(2_000)
      expect((await mcp.calls()).length).toBe(before)
      // The model is told, rather than left waiting for a result.
      await pageShows(session, 'Tool execution denied by user', 10_000)

      await newChat()
      await chooseFromMenu(session, APPROVAL_SELECT, 'Ask for approval')
      await send(session, `look up record ${CODE} once more`)
      await pageShows(session, 'Tool Approval Required', 60_000)
      await browser.$('//button[normalize-space(.)="Allow Once"]').click()
      await pageShows(session, `${RECORD} for ${CODE}`, 60_000)
      expect((await mcp.calls()).length).toBe(before + 1)
    })
  }, 300_000)
})
