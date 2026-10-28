/** Opt-in installed-client contract tests; all requests use a local scripted server. */
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invoke } from '../harness/app.js'
import { waitForChat } from '../harness/chat.js'
import { endSession, startSession, type Session } from '../harness/session.js'

const MODEL = 'test/auth-model'
const REPLY = 'ATOMIC_AUTHENTICATED_REPLY'
const prompt = 'Reply briefly without calling tools.'
const clients = [
  {
    id: 'hermes_agent',
    binary: process.env.ATOMIC_E2E_HERMES_BIN,
    args: ['chat', '-q', prompt, '-Q', '--max-turns', '1', '--ignore-rules'],
  },
  {
    id: 'openclaude',
    binary: process.env.ATOMIC_E2E_OPENCLAUDE_BIN,
    args: ['-p', prompt, '--no-session-persistence', '--tools', ''],
  },
]

describe.skipIf(!clients.some((client) => client.binary))(
  'configured client authentication',
  () => {
    let session: Session
    let server: ReturnType<typeof createServer>
    let base: string
    let expectedKey: string | null = null
    const requests: Array<{ authorized: boolean; path: string }> = []

    beforeAll(async () => {
      session = await startSession('integration-auth')
      server = createServer(async (req, res) => {
        const authorized =
          !expectedKey || req.headers.authorization === `Bearer ${expectedKey}`
        requests.push({ authorized, path: req.url ?? '' })
        if (!authorized) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                message: 'Invalid authorization',
                type: 'authentication_error',
              },
            })
          )
          return
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              object: 'list',
              data: [
                {
                  id: MODEL,
                  object: 'model',
                  owned_by: 'atomic',
                  context_length: 65536,
                },
              ],
            })
          )
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          stream?: boolean
        }
        const common = { id: 'chatcmpl-auth', model: MODEL, created: 1 }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          for (const delta of [
            { role: 'assistant', content: '' },
            { content: REPLY },
          ]) {
            res.write(
              `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
            )
          }
          res.end(
            `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
          )
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              ...common,
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: REPLY },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            })
          )
        }
      })
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      )
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('No local server address')
      base = `http://127.0.0.1:${address.port}/v1`
      await waitForChat(session)
    })

    afterAll(async () => {
      server?.closeAllConnections()
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()))
      if (session) expect(await endSession(session)).toEqual([])
    })

    for (const client of clients) {
      it.skipIf(!client.binary)(
        `${client.id} authenticates after setup, rotation and key removal`,
        async () => {
          const cwd = join(session.profile.root, client.id)
          await mkdir(cwd, { recursive: true })
          for (const key of ['first-auth-key', 'rotated-auth-key', null]) {
            expectedKey = key
            requests.length = 0
            for (let repeat = 0; repeat < 2; repeat++) {
              await invoke(session.app.browser, `configure_${client.id}`, {
                apiUrl: base,
                model: MODEL,
                apiKey: key,
                contextLength: 65536,
              })
            }
            const result = await new Promise<{
              code: number | null
              output: string
            }>((resolve, reject) => {
              const child = spawn(client.binary!, client.args, {
                cwd,
                env: {
                  PATH: process.env.PATH,
                  ...session.profile.env,
                  NO_PROXY: '127.0.0.1,localhost',
                  DISABLE_TELEMETRY: '1',
                  DISABLE_AUTOUPDATER: '1',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              let output = ''
              child.stdout.on('data', (data) => {
                output += data
              })
              child.stderr.on('data', (data) => {
                output += data
              })
              const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
              child.on('error', (error) => {
                clearTimeout(timer)
                reject(error)
              })
              child.on('close', (code) => {
                clearTimeout(timer)
                resolve({ code, output })
              })
            })
            expect(result.code, result.output.slice(-1500)).toBe(0)
            expect(result.output).toContain(REPLY)
            expect(
              requests.some((request) =>
                request.path.endsWith('/chat/completions')
              )
            ).toBe(true)
            expect(requests.every((request) => request.authorized)).toBe(true)
          }
        },
        120_000
      )
    }

    it('passes the current Zed key to a fresh CLI process', async () => {
      const destination = join(session.profile.root, 'zed-key.txt')
      await writeFile(
        join(session.profile.binDir, 'zed'),
        `#!/bin/sh\nprintf '%s' "$ATOMIC_CHAT_API_KEY" > '${destination}'\n`
      )
      await chmod(join(session.profile.binDir, 'zed'), 0o755)
      for (const key of ['first-auth-key', 'rotated-auth-key', null]) {
        await invoke(session.app.browser, 'launch_zed', { apiKey: key })
        await expect
          .poll(() => readFile(destination, 'utf8').catch(() => ''))
          .toBe(key || 'atomic')
      }
    })
  }
)
