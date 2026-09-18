/**
 * What the user keeps when a process under the chat dies. Two owners can go:
 * the backend the core spawned, and the core daemon the app spawned. In both
 * cases the conversation must survive and the next message must simply work —
 * through a fresh backend, and in the second case a fresh core the app's
 * supervisor brought up on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CRASH_TOAST,
  coreSessions,
  isAlive,
  liveFakeBackends,
  pageShows,
  pickModel,
  send,
  waitForChat,
  watchFor,
} from '../harness/chat.js'
import { readLock } from '../harness/core.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-RECOVERY 5d20'

async function startChat(name: string): Promise<Session> {
  return startSession(name, {
    prepare: async (profile) => {
      await installFakeBackend(profile, { reply: REPLY })
      await writeFakeModel(profile, MODEL_ID)
    },
  })
}

async function firstExchange(session: Session): Promise<number> {
  await waitForChat(session)
  await pickModel(session, MODEL_ID)
  await send(session, 'first message')
  await pageShows(session, REPLY, 90_000)
  const sessions = await coreSessions(session.profile.dataFolder)
  expect(sessions).toHaveLength(1)
  return sessions[0]!.pid
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the backend process dies under a loaded model', () => {
  let session: Session

  beforeAll(async () => {
    session = await startChat('recovery-backend')
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('tells the user, forgets the dead session, and answers the next message from a new backend', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      const firstBackend = await firstExchange(session)

      process.kill(firstBackend, 'SIGKILL')

      // The core notices its child is gone and says so; the app relays it and
      // restarts the model on its own within seconds, so what is stable to
      // observe is that the dead session is gone — not that none exists.
      await expect
        .poll(async () => (await coreSessions(dataFolder)).map((s) => s.pid), { timeout: 30_000 })
        .not.toContain(firstBackend)
      await pageShows(session, CRASH_TOAST, 30_000)

      await send(session, 'second message')
      await pageShows(session, REPLY, 90_000, 2)

      const sessions = await coreSessions(dataFolder)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.pid).not.toBe(firstBackend)
      expect(liveFakeBackends(dataFolder)).toEqual([sessions[0]!.pid])
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the core daemon dies under a running app', () => {
  let session: Session

  beforeAll(async () => {
    session = await startChat('recovery-core')
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('gets a new core from the supervisor, leaves no orphaned backend, and answers the next message', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      const firstBackend = await firstExchange(session)
      const firstCore = (await readLock(dataFolder))!
      const crashToast = watchFor(session, CRASH_TOAST)

      // No chance to stop its child or release its lock.
      process.kill(firstCore.pid, 'SIGKILL')

      // A new generation: another process, another instance, ready again.
      await expect
        .poll(async () => {
          const lock = await readLock(dataFolder)
          return lock && lock.state === 'ready' && lock.instance_id !== firstCore.instance_id ? lock.pid : null
        }, { timeout: 60_000 })
        .not.toBeNull()
      const secondCore = (await readLock(dataFolder))!
      expect(secondCore.pid).not.toBe(firstCore.pid)
      expect(isAlive(firstCore.pid)).toBe(false)

      // The backend the dead core left behind is reaped, not adopted.
      await expect.poll(() => isAlive(firstBackend), { timeout: 30_000 }).toBe(false)
      expect(await coreSessions(dataFolder)).toEqual([])

      await send(session, 'second message')
      await pageShows(session, REPLY, 90_000, 2)

      const sessions = await coreSessions(dataFolder)
      expect(sessions).toHaveLength(1)
      expect(liveFakeBackends(dataFolder)).toEqual([sessions[0]!.pid])

      // Recovery was silent: the user is not told a model crashed when it was
      // the owner that went away and the app put everything back by itself.
      expect(await crashToast.stop()).toBe(0)
    })
  })
})
