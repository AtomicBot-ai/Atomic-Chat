/**
 * A model under the MLX provider. On Apple silicon this is the engine most
 * local models run on, and since the migration it is the core that starts
 * `mlx-server` and owns the session. The server here is the core's scripted
 * sidecar, brought by the profile in the bundled binary's place; the model is a folder the app lists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { installFakeSidecar, MLX_PROVIDER, writeFakeMlxModel } from '../harness/bundled-sidecars.js'
import { listProcesses } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-mlx-model'
const REPLY = 'ATOMIC-E2E-MLX 5b3c'

describe.skipIf(process.platform !== 'darwin')('a model under the MLX provider', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('mlx-provider', {
      prepare: async (profile) => {
        await installFakeSidecar(profile, 'mlx', { reply: REPLY })
        await writeFakeMlxModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('is started by the core as an mlx-server session and answers the chat', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      await pickModel(session, MODEL_ID, MLX_PROVIDER)
      await send(session, 'hello, mlx')
      await pageShows(session, REPLY, 120_000)

      const sessions = ((await (await coreRequest(dataFolder, '/sessions')).json()) as {
        sessions: { model_id: string; provider: string; pid: number }[]
      }).sessions
      expect(sessions.map((s) => [s.provider, s.model_id])).toEqual([[MLX_PROVIDER, MODEL_ID]])
      const command = listProcesses().find((p) => p.pid === sessions[0]!.pid)?.command ?? ''
      // The core's own argv for it: the model folder, and a KV limit taken from
      // the model's `config.json`.
      expect(command).toContain('fake-sidecar-server.mjs')
      expect(command).toContain(`--model ${dataFolder}/mlx/models/${MODEL_ID}`)
      expect(command).toMatch(/--max-kv-size \d+/)
    })
  }, 300_000)
})
