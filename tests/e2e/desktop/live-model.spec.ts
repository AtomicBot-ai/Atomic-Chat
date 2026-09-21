/**
 * Opt-in: one chat against a real llama-server and a real model. The other
 * scenarios prove the chain with a scripted backend; this one proves the two
 * ends the script stands in for — the core's argv is one a real llama-server
 * starts with, and the core recognises it as ready.
 * It runs only when ATOMIC_E2E_LLAMA_BACKEND_DIR and ATOMIC_E2E_MODEL_GGUF are
 * set (`make test-app-e2e-live`), needs no script interpreter for the backend,
 * and is therefore also the scenario a Windows run starts from.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CRASH_TOAST, coreSessions, pageText, pickModel, send, waitForChat, watchFor } from '../harness/chat.js'
import { REAL_BACKEND_DIR, REAL_MODEL_GGUF, installRealBackend, writeRealModel } from '../harness/fixtures.js'
import { listProcesses } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/real-model'

interface StoredMessage {
  role: string
  content?: { type: string; text?: { value?: string } }[]
}

async function assistantReply(dataFolder: string): Promise<string> {
  const threads = await readdir(join(dataFolder, 'threads')).catch(() => [] as string[])
  for (const thread of threads) {
    const raw = await readFile(join(dataFolder, 'threads', thread, 'messages.jsonl'), 'utf8').catch(() => '')
    for (const line of raw.split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as StoredMessage
      if (message.role !== 'assistant') continue
      const text = (message.content ?? []).map((part) => part.text?.value ?? '').join('').trim()
      if (text !== '') return text
    }
  }
  return ''
}

describe.skipIf(!REAL_BACKEND_DIR || !REAL_MODEL_GGUF)('a chat with a real local model', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('live-model', {
      prepare: async (profile) => {
        await installRealBackend(profile, REAL_BACKEND_DIR!)
        await writeRealModel(profile, MODEL_ID, REAL_MODEL_GGUF!)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('loads it with the argv the core builds and gets an answer', { timeout: 360_000 }, async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      const crashToast = watchFor(session, CRASH_TOAST)

      await pickModel(session, MODEL_ID)
      await send(session, 'Reply with one short sentence: what is two plus two?')

      // What the model says is not asserted — that would be testing the model.
      // That it says something, and that the same text is stored and shown, is.
      await expect.poll(() => assistantReply(dataFolder), { timeout: 240_000, interval: 1_000 }).not.toBe('')
      const reply = await assistantReply(dataFolder)
      const shown = await pageText(session)
      expect(shown).toContain(reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0]!.slice(0, 24))
      expect(shown).not.toContain('[LLAMA_CPP')

      // The process is the real binary from the copied pack, started by the core.
      // Nothing is asserted about `runtime_device`: llama-server b10809 on macOS
      // prints no log lines at all by default, so the core has nothing to parse a
      // device from and reports an empty one.
      const sessions = await coreSessions(dataFolder)
      expect(sessions).toHaveLength(1)
      const command = listProcesses().find((p) => p.pid === sessions[0]!.pid)?.command ?? ''
      expect(command).toContain(join(dataFolder, 'llamacpp-upstream', 'backends'))
      expect(command).toContain('llama-server')
      expect(command).not.toContain('fake-llama-server')

      expect(await crashToast.stop()).toBe(0)
    })
  })
})
