/**
 * A local chat, end to end: the UI picks a model, the extension asks the core
 * to load it, the core spawns a backend, and a streamed reply comes back through
 * the app into the conversation and onto disk. Everything is the shipped code
 * except the backend process, which is the core's scripted fake llama-server —
 * so the test proves the chain, not a model.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invoke } from '../harness/app.js'
import {
  CHAT_INPUT,
  coreSessions,
  liveFakeBackends,
  pageShows,
  pageText,
  pickModel,
  send,
  waitForChat,
  type LocalSession,
} from '../harness/chat.js'
import {
  FAKE_BACKEND,
  FAKE_BACKEND_VERSION,
  FAKE_PROVIDER,
  installFakeBackend,
  installedBackends,
  writeFakeModel,
} from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const PROMPT = 'e2e ping 4c1d'
const REPLY = 'ATOMIC-E2E-REPLY 7f3a'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a chat with a local model', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('local-chat', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('loads the model through the core, streams the reply and keeps the thread across a restart', async () => {
    await withArtifacts(session, async () => {
      let browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, PROMPT)

      // The exact text only the fake backend produces.
      await pageShows(session, REPLY, 90_000)

      // The session the webview talks to is the one the core owns: same
      // process, same port, same key on both sides of the control API.
      const seenByApp = await invoke<LocalSession | null>(browser, 'resolve_local_session', {
        provider: FAKE_PROVIDER,
        modelId: MODEL_ID,
      })
      const seenByCore = (await coreSessions(dataFolder)).filter((s) => s.model_id === MODEL_ID)
      expect(seenByCore).toHaveLength(1)
      expect(seenByApp).toMatchObject({
        pid: seenByCore[0]!.pid,
        port: seenByCore[0]!.port,
        api_key: seenByCore[0]!.api_key,
      })

      // It was the fake that ran, and nothing else got installed meanwhile: a
      // silent backend download is the one side effect this path is known for.
      const journal = JSON.parse(
        await readFile(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8')
      ) as { processes: { pid: number; exe: string }[] }
      const child = journal.processes.find((p) => p.pid === seenByCore[0]!.pid)
      expect(child?.exe).toContain(`${FAKE_BACKEND_VERSION}/${FAKE_BACKEND}`)
      expect(await installedBackends(dataFolder)).toEqual([
        `${FAKE_PROVIDER}:${FAKE_BACKEND_VERSION}/${FAKE_BACKEND}`,
      ])

      // Both turns reached the thread store Rust owns.
      const threads = await readdir(join(dataFolder, 'threads'))
      expect(threads).toHaveLength(1)
      const stored = await readFile(join(dataFolder, 'threads', threads[0]!, 'messages.jsonl'), 'utf8')
      expect(stored).toContain(PROMPT)
      expect(stored).toContain(REPLY)

      await restartApp(session)
      browser = session.app.browser

      // A fresh process rebuilds the conversation from disk alone.
      await browser.$(CHAT_INPUT).waitForDisplayed({ timeout: 60_000 })
      // The thread list is read from disk after the shell renders.
      const thread = browser.$(`//*[normalize-space(text())="${PROMPT}"]`)
      await thread.waitForDisplayed({ timeout: 30_000 })
      await thread.click()
      await pageShows(session, REPLY, 30_000)
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a local model whose backend dies while loading', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('local-chat-load-failure', {
      prepare: async (profile) => {
        // Prints a llama.cpp-style error and exits 1 instead of becoming ready.
        await installFakeBackend(profile, { reply: REPLY, mode: 'exit-1' })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('tells the user why, offers a retry, and leaves no session or process behind', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, PROMPT)

      // The backend's own stderr and the core's error code reach the screen:
      // process → core → control API → Rust → extension → conversation.
      await pageShows(session, '[LLAMA_CPP_PROCESS_ERROR]', 90_000)
      await pageShows(session, 'main: error: something went wrong', 5_000)
      expect(await browser.$('button=Retry').isDisplayed()).toBe(true)
      expect(await pageText(session)).not.toContain(REPLY)

      // A failed load is over: nothing the webview could resolve, nothing the
      // core still counts, and no backend process left running.
      expect(await coreSessions(dataFolder)).toEqual([])
      expect(
        await invoke<LocalSession | null>(browser, 'resolve_local_session', {
          provider: FAKE_PROVIDER,
          modelId: MODEL_ID,
        })
      ).toBeNull()
      expect(liveFakeBackends(dataFolder)).toEqual([])
    })
  })
})
