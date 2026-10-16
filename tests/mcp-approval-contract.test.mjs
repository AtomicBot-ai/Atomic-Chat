/**
 * MCP tools are third-party code acting on the user's behalf, so both engines
 * ask before running them unless the user deliberately opted in. This pins the
 * frontend ⇄ Rust contract that keeps that true; the behaviour itself is
 * tested in `runner_tests.rs`, `useToolApproval.test.ts` and
 * `mcp-approval.test.ts`.
 *
 * See docs/decisions/2026-10-16-ask-before-every-mcp-and-third-party-tool-call.md.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

test('the agent wire request asks unless auto_approve_mcp is sent', () => {
  const types = read('src-tauri/src/core/agent/types.rs')
  assert.match(
    types,
    /#\[serde\(default\)\]\s*pub auto_approve_mcp: bool,/,
    'AgentTurnRequest.auto_approve_mcp must default to false'
  )
})

test('readOnlyHint never skips the agent approval gate', () => {
  const resourceClass = read('src-tauri/src/core/agent/resource_class.rs')
  assert.doesNotMatch(resourceClass, /McpRead/, 'no read-only MCP bypass class')
  assert.doesNotMatch(
    resourceClass,
    /descriptor\.read_only/,
    'MCP classification must not depend on the server-supplied hint'
  )
  const tools = read('src-tauri/src/core/agent/tools/mod.rs')
  assert.match(
    tools,
    /mcp_opt_in_waives_approval\(&prepared\.call\.tool, context\.auto_approve_mcp\)/,
    'the MCP opt-in is applied in exactly one named place'
  )
})

test('the chat store defaults to asking and resets the inherited opt-in once', () => {
  const store = read('web-app/src/hooks/useToolApproval.ts')
  assert.match(store, /allowAllMCPPermissions: false,/)
  assert.doesNotMatch(store, /allowAllMCPPermissions: true/)
  assert.match(store, /TOOL_APPROVAL_STORE_VERSION = 2/)
})

test('both engines take the opt-in from the same resolver', () => {
  const thread = read('web-app/src/routes/threads/$threadId.tsx')
  assert.match(thread, /auto_approve_mcp: resolveMcpAutoApprove\(threadId\)/)
  assert.match(thread, /approve: approveChatToolCall,/)
})
