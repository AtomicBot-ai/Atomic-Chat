// Exercise the shipped executable and approval extension without a user profile or model download.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const root = fileURLToPath(new URL('../', import.meta.url))
const binary = join(
  root,
  'src-tauri/resources/pi',
  process.platform === 'win32' ? 'pi.exe' : 'pi'
)
const extension = join(
  root,
  'src-tauri/src/core/pi_agent/extension/atomic-approval.ts'
)
const profile = mkdtempSync(join(tmpdir(), 'atomic-pi-smoke-'))
const shell = process.platform === 'win32' ? 'powershell' : 'bash'
const shellPrompt = 'Run the shell fixture.'
const workspace = join(profile, 'workspace')
mkdirSync(workspace)
const server = createServer(async (request, response) => {
  const parts = []
  for await (const part of request) parts.push(part)
  const messages = JSON.parse(Buffer.concat(parts)).messages
  const done = messages.at(-1).role === 'tool'
  const useShell = JSON.stringify(messages.at(-1).content).includes(shellPrompt)
  const delta = done
    ? { role: 'assistant', content: 'Finished' }
    : {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'fixture-call',
            type: 'function',
            function: {
              name: useShell ? shell : 'write',
              arguments: JSON.stringify(
                useShell
                  ? {
                      command:
                        shell === 'powershell'
                          ? "Write-Output 'atomic-shell-ok'"
                          : 'echo atomic-shell-ok',
                    }
                  : {
                      path: 'marker',
                      content: 'approved',
                    }
              ),
            },
          },
        ],
      }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [content, reason] of [
    [delta, null],
    [{}, done ? 'stop' : 'tool_calls'],
  ]) {
    const chunk = {
      id: 'smoke',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'smoke',
      choices: [{ index: 0, delta: content, finish_reason: reason }],
    }
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.end('data: [DONE]\n\n')
})

let child
let timer
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  writeFileSync(
    join(profile, 'models.json'),
    JSON.stringify({
      providers: {
        atomic: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [{ id: 'smoke', contextWindow: 32768, maxTokens: 2048 }],
        },
      },
    })
  )
  child = spawn(
    binary,
    [
      '--mode',
      'rpc',
      '--provider',
      'atomic',
      '--model',
      'smoke',
      '--tools',
      'write,' + shell,
      '-ne',
      '-e',
      extension,
      '-ns',
      '--no-mcp',
      '--no-approve',
      '--offline',
      '--session-dir',
      join(profile, 'sessions'),
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: profile,
        USERPROFILE: profile,
        PI_CODING_AGENT_DIR: profile,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    }
  )
  const closed = once(child, 'close')
  timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const records = lines[Symbol.asyncIterator]()
  async function next(matches) {
    for (;;) {
      const record = await records.next()
      assert.ok(!record.done, 'pi exited before the expected RPC record')
      const event = JSON.parse(record.value)
      assert.notEqual(event.type, 'extension_error')
      if (matches(event)) return event
    }
  }
  const send = (command) => child.stdin.write(JSON.stringify(command) + '\n')
  await next(
    (event) =>
      event.type === 'extension_ui_request' &&
      event.message === 'atomic-approval-ready-v1'
  )
  for (const type of ['get_state', 'get_commands']) {
    send({ type, id: type })
    const result = await next(
      (event) => event.type === 'response' && event.id === type
    )
    assert.equal(result.success, true)
    if (type === 'get_state') assert.equal(result.data.model.provider, 'atomic')
  }
  send({ type: 'prompt', id: 'turn', message: 'Write the fixture marker.' })
  const ui = await next(
    (event) =>
      event.type === 'extension_ui_request' && event.method === 'select'
  )
  assert.equal(JSON.parse(ui.title).tool, 'write')
  assert.equal(existsSync(join(workspace, 'marker')), false)
  send({ type: 'extension_ui_response', id: ui.id, value: 'Deny' })
  const outcome = await next((event) => event.type === 'tool_execution_end')
  assert.equal(outcome.isError, true)
  await next((event) => event.type === 'agent_settled')
  assert.equal(existsSync(join(workspace, 'marker')), false)
  send({ type: 'prompt', id: 'shell', message: shellPrompt })
  const approval = await next(
    (event) =>
      event.type === 'extension_ui_request' && event.method === 'select'
  )
  assert.equal(JSON.parse(approval.title).tool, shell)
  send({ type: 'extension_ui_response', id: approval.id, value: 'Allow' })
  const result = await next((event) => event.type === 'tool_execution_end')
  assert.equal(result.isError, false)
  assert.match(JSON.stringify(result.result.content), /atomic-shell-ok/)
  await next((event) => event.type === 'agent_settled')
  child.stdin.end()
  assert.equal((await closed)[0], 0)
  console.log(`pi RPC, denied write and approved ${shell} passed`)
} finally {
  clearTimeout(timer)
  if (child && child.exitCode === null && !child.signalCode)
    child.kill('SIGKILL')
  server.closeAllConnections()
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
