/**
 * A stdio MCP server with one tool, placed in a profile. It is a Node script
 * the app launches itself from `mcp_config.json`, so everything around it is
 * the shipped path: the spawn, the handshake, the tool listing, the call. Every
 * call it receives is appended to a log in the profile, which is how a scenario
 * knows a tool ran — or did not.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Profile } from './profile.js'

export const MCP_SERVER_NAME = 'e2e-records'
export const MCP_TOOL = 'e2e_lookup_record'

const SCRIPT = `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [, , log, answer] = process.argv
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try { request = JSON.parse(line) } catch { return }
  const { id, method, params } = request
  if (id === undefined) return // a notification
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: '${MCP_SERVER_NAME}', version: '1.0.0' },
    } })
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [{
      name: '${MCP_TOOL}',
      description: 'Looks up a record by its code.',
      inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    }] } })
  }
  if (method === 'tools/call') {
    appendFileSync(log, JSON.stringify(params) + '\\n')
    return send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: answer + ' for ' + String(params?.arguments?.code) }],
    } })
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
})
`

export interface McpFixture {
  /** The `tools/call` requests the server has received, in order. */
  calls: () => Promise<{ name: string; arguments: Record<string, unknown> }[]>
}

/** Writes the server and makes it the profile's one active MCP server. */
export async function installMcpServer(profile: Profile, options: { answer: string }): Promise<McpFixture> {
  const script = join(profile.root, 'e2e-mcp-server.mjs')
  const log = join(profile.root, 'e2e-mcp-calls.jsonl')
  await writeFile(script, SCRIPT)
  await writeFile(
    join(profile.dataFolder, 'mcp_config.json'),
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: { command: process.execPath, args: [script, log, options.answer], env: {}, active: true },
      },
    })
  )
  return {
    calls: async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { name: string; arguments: Record<string, unknown> }),
  }
}
