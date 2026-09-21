/**
 * What a user does to a conversation after the first reply: stops an answer
 * that runs long, asks for another one, rewrites their question, removes a
 * message, renames the thread and deletes it. Every step is checked twice — on
 * the page, and in the thread store the Rust side keeps on disk, which is what a
 * restart would read.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseFromMenu, coreSessions, occurrences, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'

interface StoredMessage {
  id: string
  role: string
  status: string
  text: string
}

/** The one thread's messages as they are on disk. */
async function storedMessages(dataFolder: string): Promise<StoredMessage[]> {
  const threads = await readdir(join(dataFolder, 'threads')).catch(() => [] as string[])
  if (threads.length === 0) return []
  expect(threads).toHaveLength(1)
  const raw = await readFile(join(dataFolder, 'threads', threads[0]!, 'messages.jsonl'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const message = JSON.parse(line) as {
        id: string
        role: string
        status?: string
        content?: { text?: { value?: string } }[]
      }
      return {
        id: message.id,
        role: message.role,
        status: message.status ?? '',
        text: (message.content ?? []).map((part) => part.text?.value ?? '').join(''),
      }
    })
}

// The stop button carries no name of its own; it is the composer's only
// destructive button, shown in place of Send while a reply streams.
const STOP = 'button[data-variant="destructive"].rounded-full'
const SEND = '[data-test-id="send-message-button"]'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('stopping a reply', () => {
  // The scripted backend sends a word every 5 ms: long enough to be stopped
  // midway, with a last word that must never arrive.
  const FIRST = 'ATOMIC-E2E-LONG-START'
  const LAST = 'ATOMIC-E2E-LONG-END'
  const REPLY = [FIRST, ...Array.from({ length: 4000 }, (_, i) => `w${i}`), LAST].join(' ')
  let session: Session

  beforeAll(async () => {
    session = await startSession('chat-stop', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('cuts the answer short, keeps the model, and takes the next message', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'tell me everything')

      await pageShows(session, FIRST, 90_000)
      await browser.$(STOP).click()

      // Send is back, the answer stays where it was cut, and its end never comes.
      await browser.$(SEND).waitForDisplayed({ timeout: 15_000 })
      const cutAt = (await browser.$('body').getText()).length
      await new Promise((r) => setTimeout(r, 2_000))
      expect((await browser.$('body').getText()).length).toBe(cutAt)
      expect(await occurrences(session, LAST)).toBe(0)

      // The cut answer stays on the page, and what was received of it is in the
      // store as the assistant's turn, so a restart shows the same conversation.
      expect(await occurrences(session, FIRST)).toBe(1)
      await expect
        .poll(async () => (await storedMessages(dataFolder)).map((m) => m.role), { timeout: 15_000 })
        .toEqual(['user', 'assistant'])
      const kept = (await storedMessages(dataFolder))[1]!
      expect(kept.text).toContain(FIRST)
      expect(kept.text).not.toContain(LAST)
      expect(kept.status).toBe('stopped')

      // Stopping a reply is not stopping the model: the same process answers next.
      const before = await coreSessions(dataFolder)
      expect(before.map((s) => s.model_id)).toEqual([MODEL_ID])
      await send(session, 'and again')
      await pageShows(session, FIRST, 60_000, 2)
      await browser.$(STOP).click()
      await browser.$(SEND).waitForDisplayed({ timeout: 15_000 })
      expect((await coreSessions(dataFolder)).map((s) => s.pid)).toEqual(before.map((s) => s.pid))
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('reworking a conversation', () => {
  const REPLY = 'ATOMIC-E2E-WORKFLOW 5c2d'
  const PROMPT = 'first question e2e'
  const REWRITTEN = 'rewritten question e2e'
  const TITLE = 'Renamed by e2e'
  let session: Session

  beforeAll(async () => {
    session = await startSession('chat-workflows', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('regenerates, rewrites, removes a message, renames the thread and deletes it', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, PROMPT)
      await pageShows(session, REPLY, 90_000)
      await expect.poll(async () => (await storedMessages(dataFolder)).map((m) => m.role)).toEqual(['user', 'assistant'])
      const first = await storedMessages(dataFolder)

      // Another answer to the same question replaces the first one.
      await browser.$('button[title="Regenerate response"]').click()
      await expect
        .poll(async () => (await storedMessages(dataFolder)).find((m) => m.role === 'assistant')?.id, { timeout: 60_000 })
        .not.toBe(first[1]!.id)
      await pageShows(session, REPLY, 60_000)
      const regenerated = await storedMessages(dataFolder)
      expect(regenerated.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(regenerated[0]!.id).toBe(first[0]!.id)
      expect(await occurrences(session, REPLY)).toBe(1)

      // Rewriting the question asks it again in the new words. The old ones
      // stay only as the thread's title, which was taken from them.
      const mentions = await occurrences(session, PROMPT)
      await browser.$('(//button[@aria-label="Edit Message"])[1]').click()
      const editor = browser.$('textarea[aria-label="Edit Message"]')
      await editor.waitForDisplayed({ timeout: 10_000 })
      await editor.setValue(REWRITTEN)
      await browser.keys('Enter')
      await expect
        .poll(async () => (await storedMessages(dataFolder)).map((m) => `${m.role}:${m.text}`), { timeout: 60_000 })
        .toEqual([`user:${REWRITTEN}`, `assistant:${REPLY}`])
      expect(await occurrences(session, PROMPT)).toBe(mentions - 1)
      expect(await occurrences(session, REWRITTEN)).toBe(1)

      // Removing the answer takes it off the page and out of the store.
      await browser.$('(//button[@aria-label="Edit Message"])[2]/following-sibling::button[1]').click()
      await browser.$('button[aria-label="Delete Message"]').click()
      await expect
        .poll(async () => (await storedMessages(dataFolder)).map((m) => m.role), { timeout: 30_000 })
        .toEqual(['user'])
      expect(await occurrences(session, REPLY)).toBe(0)

      // The thread gets the user's own name, in the list and on disk.
      const threads = await readdir(join(dataFolder, 'threads'))
      const threadFile = join(dataFolder, 'threads', threads[0]!, 'thread.json')
      const row = `//a[contains(@href, "${threads[0]!}")]/following-sibling::button`
      await chooseFromMenu(session, row, 'Rename')
      const title = browser.$('input[aria-label="Thread Title"]')
      await title.waitForDisplayed({ timeout: 10_000 })
      await title.setValue(TITLE)
      await browser.keys('Enter')
      await browser.$(`//a[contains(@href, "${threads[0]!}")]//*[normalize-space(text())="${TITLE}"]`).waitForDisplayed({
        timeout: 15_000,
      })
      await expect
        .poll(async () => (JSON.parse(await readFile(threadFile, 'utf8')) as { title: string }).title, { timeout: 15_000 })
        .toBe(TITLE)

      // Deleting the thread removes it from the list and from disk.
      await chooseFromMenu(session, row, 'Delete')
      await browser.$(`button[aria-label="Delete ${TITLE}"]`).click()
      await expect.poll(() => readdir(join(dataFolder, 'threads')), { timeout: 30_000 }).toEqual([])
      await browser.$(`//a[contains(@href, "${threads[0]!}")]`).waitForExist({ reverse: true, timeout: 15_000 })
      await waitForChat(session)
    })
  })
})
