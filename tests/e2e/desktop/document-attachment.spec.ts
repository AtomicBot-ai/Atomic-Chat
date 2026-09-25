/**
 * Attaching a document to a conversation, the way that needs embeddings: the
 * file is parsed and chunked by the app, the chunks are embedded by the core —
 * which loads the embedding model as a process of its own, in embedding mode —
 * and the vectors are stored for the thread. Then the model asks for them: the
 * app offers it a `retrieve` tool, the scripted chat model calls it, and the
 * document's words come back into the conversation. The embedding model is
 * placed in the profile (the app would otherwise download it), and the scripted
 * backend answers `/v1/embeddings` with three numbers per text, which is how
 * the stored vectors are known to have come through the core.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseFromMenu, fakeBackendCommands, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { answerNextDialog, EMBEDDING_MODEL_ID, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-DOCS 4d7b'
const DOCUMENT_NAME = 'e2e-field-notes.txt'
const DOCUMENT_TEXT = 'ATOMIC-E2E-DOC 9f21: the kingfisher nests in the river bank in March.'

// The composer's "+" menu; its trigger has no name of its own.
const ATTACH_MENU = 'button[aria-haspopup="menu"].rounded-full.mr-2'

const setting = (key: string, value: unknown) => ({ key, controllerProps: { value } })

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a document attached for retrieval', () => {
  let session: Session
  let documentPath = ''

  beforeAll(async () => {
    session = await startSession('document-attachment', {
      // Always embed, whatever the document's size, and search without the ANN
      // index, which only some platforms ship.
      webviewSeed: {
        '@janhq/rag-extension': JSON.stringify([setting('parse_mode', 'embeddings'), setting('search_mode', 'linear')]),
      },
      prepare: async (profile) => {
        // The chat model's one scripted move: when the app offers `retrieve`, call it.
        await installFakeBackend(profile, { reply: REPLY, toolCall: { name: 'retrieve', arguments: { query: 'where does the kingfisher nest' } } })
        await writeFakeModel(profile, MODEL_ID, { tools: true })
        await writeFakeModel(profile, EMBEDDING_MODEL_ID, { embedding: true })
        const documents = join(profile.home, 'Documents')
        await mkdir(documents, { recursive: true })
        documentPath = join(documents, DOCUMENT_NAME)
        await writeFile(documentPath, DOCUMENT_TEXT)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('is chunked by the app, embedded by the core, stored for the thread, and retrieved when the model asks', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      // A document belongs to a thread, so there has to be one.
      await send(session, 'I have some notes for you')
      await pageShows(session, REPLY, 90_000)

      await answerNextDialog(session.profile, [documentPath])
      await chooseFromMenu(session, ATTACH_MENU, 'Add documents')
      await pageShows(session, DOCUMENT_NAME, 60_000)

      // The embedding model may be gone again by the time anyone looks, so its
      // process is watched for from before the message that triggers indexing.
      const embeddingRuns = new Set<string>()
      let watching = true
      const watcher = (async () => {
        while (watching) {
          for (const command of fakeBackendCommands(dataFolder)) {
            if (command.includes(EMBEDDING_MODEL_ID)) embeddingRuns.add(command)
          }
          await new Promise((r) => setTimeout(r, 100))
        }
      })()
      await send(session, 'what do the notes say')
      // Seen about once in a dozen long runs, never alone: the turn that should
      // call `retrieve` ends empty — no tool block, no text, no third request.
      // Unexplained so far; when it happens again this says what the thread
      // store and the console held.
      await pageShows(session, REPLY, 90_000, 2).catch(async (error) => {
        const threadsDir = join(dataFolder, 'threads')
        const ids = await readdir(threadsDir)
        console.log('DIAG store', (await readFile(join(threadsDir, ids[0]!, 'messages.jsonl'), 'utf8')).slice(-1500))
        const state = await session.app.browser.execute(() => {
          const w = window as unknown as { __atomic_e2e_console?: string[] }
          return (w.__atomic_e2e_console ?? []).filter((l) => /tool|Tool|RAG|retrieve|abort|Abort/.test(l)).slice(-12)
        })
        console.log('DIAG console', JSON.stringify(state))
        throw error
      })

      // The thread's collection lives in the data folder, with everything else
      // that moves when the folder is moved and goes when the app is reset —
      // not in the fixed place under the home directory it used to be in.
      const dbDir = join(dataFolder, 'db')
      const legacyDir = join(session.profile.home, 'Library', 'Application Support', 'Atomic Chat', 'data', 'db')
      const collections = async () => (await readdir(dbDir).catch(() => [] as string[])).filter((n) => n.startsWith('attachments_'))
      await expect.poll(collections, { timeout: 60_000 }).toHaveLength(1)

      watching = false
      await watcher

      expect((await readdir(legacyDir).catch(() => [] as string[])).filter((n) => n.startsWith('attachments_'))).toEqual([])

      // The core ran the embedding model as a process of its own, in embedding mode.
      expect(embeddingRuns.size).toBeGreaterThan(0)
      for (const command of embeddingRuns) expect(command).toContain('--embedding --pooling mean')

      // One file, one chunk with the document's words, and the vector the
      // scripted backend gives for a text of that length: it went through the core.
      const db = join(dbDir, (await collections())[0]!)
      const query = (sql: string) => JSON.parse(execFileSync('sqlite3', ['-json', db, sql]).toString() || '[]') as Record<string, unknown>[]
      expect(query('SELECT name, chunk_count FROM files')).toEqual([{ name: DOCUMENT_NAME, chunk_count: 1 }])
      const chunks = query('SELECT text, hex(embedding) AS vector FROM chunks')
      expect(chunks.map((c) => c.text)).toEqual([DOCUMENT_TEXT])
      const vector = Buffer.from(String(chunks[0]!.vector), 'hex')
      expect([vector.readFloatLE(0), vector.readFloatLE(4), vector.readFloatLE(8)].map((v) => Number(v.toFixed(3)))).toEqual([
        DOCUMENT_TEXT.length,
        0.2,
        0.3,
      ])

      // The model asked for the notes and got them. The app offered it `retrieve`
      // because the thread has documents; the scripted model called it; the query
      // was embedded by the core and matched against the stored chunk; and what
      // came back — the document's own words — was in front of the model when it
      // answered, which the scripted model shows by repeating it.
      await pageShows(session, 'tool said', 30_000)
      const threads = await readdir(join(dataFolder, 'threads'))
      expect(threads).toHaveLength(1)
      const stored = (await readFile(join(dataFolder, 'threads', threads[0]!, 'messages.jsonl'), 'utf8'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { role: string; content?: Record<string, unknown>[] })
      const parts = stored.filter((m) => m.role === 'assistant').flatMap((m) => m.content ?? [])
      const call = parts.find((part) => part.type === 'tool_call')
      expect(call?.tool_name).toBe('retrieve')
      expect(JSON.stringify(call?.input)).toContain('kingfisher')
      expect(JSON.stringify(call?.output)).toContain(DOCUMENT_TEXT.slice(0, 40))
      const lastText = JSON.stringify(parts.filter((part) => part.type === 'text').at(-1))
      expect(lastText).toContain(REPLY)
      expect(lastText).toContain('ATOMIC-E2E-DOC 9f21')

      // Nothing was fetched to do it: the models folder holds what the profile was given.
      const models = await readdir(join(dataFolder, 'llamacpp', 'models'))
      expect(models.sort()).toEqual(['e2e', EMBEDDING_MODEL_ID].sort())
    })
  }, 300_000)
})
