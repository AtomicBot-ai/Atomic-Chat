/**
 * A prompt that does not fit the context window. llama.cpp answers such a
 * request with `exceed_context_size_error`; with auto-increase on (the default)
 * the app is supposed to grow the model's context along its ladder, reload the
 * model and answer — without the user doing anything. The ladder only applies
 * when the engine is not sizing the context itself, so the profile turns the
 * provider's `fit` off; that switch is a precondition here, not the subject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CRASH_TOAST,
  coreSessions,
  fakeBackendCommands,
  isAlive,
  pageShows,
  pageText,
  pickModel,
  send,
  waitForChat,
  watchFor,
} from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-CONTEXT c81e'
/** Above the window the app loads with by default (16384), within one step of its ladder. */
const BACKEND_NEEDS_CTX = 20_000

const ctxSizes = (dataFolder: string): number[] =>
  fakeBackendCommands(dataFolder).map((command) => Number(/--ctx-size (\d+)/.exec(command)?.[1] ?? Number.NaN))

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a request that overflows the context window', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('context-growth', {
      prepare: async (profile) => {
        // Answers the context-overflow error while `--ctx-size` is below the threshold.
        await installFakeBackend(profile, { reply: REPLY, minCtx: BACKEND_NEEDS_CTX })
        await writeFakeModel(profile, MODEL_ID)
      },
      // The extension adopts stored values by key, so one entry is a whole seed.
      webviewSeed: {
        '@janhq/llamacpp-upstream-extension': JSON.stringify([
          { key: 'fit', controllerProps: { value: false } },
        ]),
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('grows the context, reloads the model and answers without being asked', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      const crashToast = watchFor(session, CRASH_TOAST)
      await pickModel(session, MODEL_ID)

      // The precondition held: with `fit` off the core passes an explicit
      // window, and it is too small for this backend.
      await expect.poll(() => ctxSizes(dataFolder).length, { timeout: 60_000 }).toBe(1)
      const [smallWindow] = ctxSizes(dataFolder)
      expect(smallWindow).toBeLessThan(BACKEND_NEEDS_CTX)
      // The process is visible a moment before the core lists its session.
      await expect.poll(async () => (await coreSessions(dataFolder)).length, { timeout: 30_000 }).toBe(1)
      const smallBackend = (await coreSessions(dataFolder))[0]!.pid

      await send(session, 'a prompt the small window rejects')
      await pageShows(session, REPLY, 120_000)

      // The window grew past what the backend asked for, and the bigger
      // process replaced the small one rather than joining it.
      const grown = ctxSizes(dataFolder)
      expect(grown).toHaveLength(1)
      expect(grown[0]).toBeGreaterThanOrEqual(BACKEND_NEEDS_CTX)
      expect(isAlive(smallBackend)).toBe(false)
      expect(await coreSessions(dataFolder)).toHaveLength(1)

      // The detour left no trace for the user: the reply stands alone, the
      // growth indicator is gone, and a deliberate reload was not called a crash.
      const text = await pageText(session)
      expect(text).not.toContain('Growing the Mind')
      expect(text).not.toContain('exceed')
      expect(await crashToast.stop()).toBe(0)
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('an overflow the app cannot grow out of', () => {
  let session: Session

  beforeAll(async () => {
    // `fit` stays on, as shipped: the engine sizes the window itself, there is
    // no ladder to climb, and the backend keeps answering the overflow error.
    session = await startSession('context-overflow-fit', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY, minCtx: BACKEND_NEEDS_CTX })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('explains that the context is fitted to the device', async () => {
    await withArtifacts(session, async () => {
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'a prompt no window here will take')
      await pageShows(session, "The context is fitted to this device's memory", 60_000)
    })
  })

  // KNOWN DEFECT (2026-09-18): after that explanation the thread is a dead end.
  // "Growing the Mind..." never goes away, no error or Retry appears and the
  // send button stays disabled. In routes/threads/$threadId.tsx the overflow
  // effect raises `isAutoIncreasingContext` and calls `handleContextSizeIncrease`,
  // which returns on `fit` / `at_max` without lowering it or clearing the active
  // request; both are only lowered on a chat status change, and the status is
  // already `error`. `it.fails` keeps the suite green while the defect stands
  // and turns red once it is fixed — remove the marker then.
  it.fails('gives the conversation back to the user afterwards', async () => {
    const browser = session.app.browser
    await browser.waitUntil(async () => !(await pageText(session)).includes('Growing the Mind'), {
      timeout: 20_000,
      timeoutMsg: 'the growth indicator never went away',
    })
    await browser.$('[data-testid="chat-input"]').setValue('still here?')
    await browser.$('[data-test-id="send-message-button"]').waitForEnabled({ timeout: 10_000 })
  })
})
