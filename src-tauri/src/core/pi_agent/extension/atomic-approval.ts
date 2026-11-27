import { readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// Pi expands @, ~, file URLs, Windows shell drive paths and Unicode spaces
// before a read. Ask on those aliases and on paths we cannot canonicalize.
async function isWorkspaceRead(cwd: string, path: unknown): Promise<boolean> {
  if (
    typeof path !== 'string' ||
    /^[@~]|^file:\/\//i.test(path) ||
    /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/u.test(path) ||
    (process.platform === 'win32' && path.startsWith('/'))
  )
    return false
  try {
    const root = await realpath(cwd)
    const file = await realpath(resolve(root, path))
    const rel = relative(root, file)
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
  } catch {
    return false
  }
}

export default function atomicApproval(pi: ExtensionAPI) {
  const catalogPath = process.env.ATOMIC_PI_INTEGRATIONS
  const catalog: {
    assistantInstructions?: string
    sampling?: Record<string, number>
    reasoningFields?: Record<
      string,
      {
        chat_template_kwargs?: Record<string, unknown>
        reasoning_effort?: string
        reasoning_budget_tokens?: number
        thinking_budget?: number
        thinking?: Record<string, unknown>
        reasoning?: Record<string, unknown>
      }
    >
    secureProject?: boolean
    skills: Array<{ name: string; path: string }>
    tools: Array<{
      projectTool?: boolean
      alias: string
      name: string
      server: string
      description: string
      parameters: Parameters<ExtensionAPI['registerTool']>[0]['parameters']
    }>
  } = catalogPath
    ? JSON.parse(readFileSync(catalogPath, 'utf8'))
    : { skills: [], tools: [] }
  const tools = new Map(catalog.tools.map((tool) => [tool.alias, tool]))
  if (catalog.sampling || catalog.reasoningFields) {
    pi.on('before_provider_request', ({ payload }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return
      const body: Record<string, unknown> = { ...payload, ...catalog.sampling }
      const fields = catalog.reasoningFields?.[pi.getThinkingLevel()]
      if (fields) {
        for (const key of [
          'reasoning_effort',
          'thinking_budget',
          'reasoning_budget_tokens',
          'thinking',
          'reasoning',
        ] as const) {
          if (fields[key] !== undefined) body[key] = fields[key]
        }
        if (fields.chat_template_kwargs) {
          body.chat_template_kwargs = {
            ...(body.chat_template_kwargs as object),
            ...fields.chat_template_kwargs,
          }
        }
      }
      return body
    })
  }
  if (catalog.assistantInstructions) {
    pi.on('before_agent_start', (event) => ({
      systemPrompt:
        event.systemPrompt +
        '\n\nAssistant instructions:\n' +
        catalog.assistantInstructions,
    }))
  }
  if (catalog.skills.length) {
    pi.on('resources_discover', () => ({
      skillPaths: catalog.skills.map((skill) => skill.path),
    }))
    pi.on('input', (event) => {
      const match = /^\/([a-z0-9_-]+)(?=\s|$)/.exec(event.text)
      if (
        match &&
        !['compact', 'name'].includes(match[1]) &&
        catalog.skills.some((skill) => skill.name === match[1])
      ) {
        return {
          action: 'transform',
          text: '/skill:' + event.text.slice(1),
          images: event.images,
        }
      }
    })
    pi.on('before_agent_start', (event) => ({
      systemPrompt:
        event.systemPrompt +
        '\nAtomic Chat skills may use legacy tool names. Use read for os.fs.read, edit/write for file changes, and the available shell for equivalent command-line operations. Resolve declared skill scripts relative to their skill directory. Use an enabled connector when its tool matches. If a required capability or connector is unavailable, tell the user. Respect disabled tools.',
    }))
  }
  for (const tool of catalog.tools) {
    pi.registerTool({
      name: tool.alias,
      label: tool.server + ' / ' + tool.name,
      description:
        tool.server +
        ' / ' +
        tool.name +
        (tool.description ? ': ' + tool.description : ''),
      parameters: tool.parameters,
      async execute(_id, args, signal, _update, ctx) {
        if (!ctx.hasUI || signal?.aborted)
          throw new Error('Atomic Chat connector unavailable')
        const value = await ctx.ui.input(
          'atomic-chat-mcp-v1',
          JSON.stringify({ alias: tool.alias, arguments: args }),
          { signal }
        )
        if (!value) throw new Error('Atomic Chat connector cancelled')
        const result = JSON.parse(value)
        if (result.isError)
          throw new Error(
            result.content?.find(
              (part: { type: string }) => part.type === 'text'
            )?.text ?? 'Connector failed'
          )
        const content = (result.content ?? []).map(
          (part: {
            type: string
            text?: string
            mimeType?: string
            data?: string
          }) => {
            if (part.type === 'text' || part.type === 'image') return part
            return { type: 'text', text: JSON.stringify(part) }
          }
        )
        if (!content.length && result.structuredContent !== undefined)
          content.push({
            type: 'text',
            text: JSON.stringify(result.structuredContent),
          })
        return { content, details: {} }
      },
    })
  }
  pi.on('session_start', (_event, ctx) => {
    const active = new Set(pi.getActiveTools())
    if (catalog.tools.some((tool) => !active.has(tool.alias)))
      throw new Error('Atomic Chat connector tools failed to load')
    ctx.ui.notify('atomic-approval-ready-v1', 'info')
  })
  pi.on('tool_call', async (event, ctx) => {
    const denied = {
      block: true,
      reason: 'Atomic Chat declined this tool call.',
    }
    try {
      if (catalog.secureProject && !tools.has(event.toolName)) return denied
      if (
        event.toolName === 'read' &&
        (await isWorkspaceRead(ctx.cwd, event.input.path))
      )
        return
      if (!ctx.hasUI || ctx.signal?.aborted) return denied
      const connector = tools.get(event.toolName)
      const title = JSON.stringify({
        type: 'atomic-approval',
        tool: connector
          ? connector.server + ' / ' + connector.name
          : event.toolName,
        connector:
          connector && !connector.projectTool
            ? { server: connector.server, name: connector.name }
            : undefined,
        input: event.input,
      })
      const answer = await ctx.ui.select(title, ['Allow', 'Deny'], {
        signal: ctx.signal,
      })
      if (answer === 'Allow' && !ctx.signal?.aborted) return
    } catch {
      // A closed channel or a missing UI must resolve a pending call safely.
    }
    return denied
  })
}
