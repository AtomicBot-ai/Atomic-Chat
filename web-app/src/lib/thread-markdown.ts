/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A chat as one Markdown document (ATO-504): the title, then every message under
 * its role, in the order the chat shows them. It is built from the same UI parts
 * the chat renders, so reasoning, tool calls and attachments read as they do on
 * screen. Inline image data is named, never embedded: one photo would turn the
 * file into megabytes of base64.
 */
import type { UIMessage } from '@ai-sdk/react'

/** Longer tool results are cut; the full result stays in the chat. */
export const TOOL_OUTPUT_LIMIT = 4000

const ROLE_HEADINGS: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
}

/** A fenced block whose fence is longer than any backtick run inside it. */
const fenced = (body: string, language = ''): string => {
  const longestRun = Math.max(
    2,
    ...(body.match(/`+/g) ?? []).map((run) => run.length)
  )
  const fence = '`'.repeat(longestRun + 1)
  return `${fence}${language}\n${body}\n${fence}`
}

const collapsed = (summary: string, body: string): string =>
  `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`

const asText = (value: unknown): string => {
  if (typeof value === 'string') return value
  // MCP results arrive as `[{ type: 'text', text }]`.
  if (
    Array.isArray(value) &&
    value.every(
      (item) => item?.type === 'text' && typeof item.text === 'string'
    )
  ) {
    return value.map((item) => item.text).join('\n')
  }
  return JSON.stringify(value, null, 2) ?? ''
}

const truncated = (text: string): string =>
  text.length > TOOL_OUTPUT_LIMIT
    ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… (truncated)`
    : text

const fileMarkdown = (part: any): string => {
  const url = String(part.url ?? '')
  const name = part.filename || part.mediaType || 'file'
  if (!url || url.startsWith('data:')) return `_Attached: ${name}_`
  const isImage = String(part.mediaType ?? '').startsWith('image/')
  return `${isImage ? '!' : ''}[${name}](<${url}>)`
}

const toolMarkdown = (name: string, part: any): string => {
  const blocks = [`**Tool call:** \`${name}\``]
  if (part.input !== undefined) {
    blocks.push(fenced(JSON.stringify(part.input, null, 2) ?? '', 'json'))
  }
  if (part.state === 'output-error') {
    blocks.push(`Error: ${part.errorText ?? 'unknown error'}`)
  } else if (part.state === 'output-available') {
    blocks.push(collapsed('Result', fenced(truncated(asText(part.output)))))
  }
  return blocks.join('\n\n')
}

const partMarkdown = (part: any): string | undefined => {
  if (part.type === 'text') return part.text?.trim() || undefined
  if (part.type === 'reasoning') {
    return part.text?.trim()
      ? collapsed('Reasoning', part.text.trim())
      : undefined
  }
  if (part.type === 'file') return fileMarkdown(part)
  if (part.type === 'source-url' && part.url) {
    return `[${part.title || part.url}](<${part.url}>)`
  }
  if (part.type === 'dynamic-tool') return toolMarkdown(part.toolName, part)
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    return toolMarkdown(part.type.slice('tool-'.length), part)
  }
  return undefined
}

const roleHeading = (role: string): string =>
  ROLE_HEADINGS[role] ?? role.charAt(0).toUpperCase() + role.slice(1)

/**
 * The whole chat as Markdown. `exportedAt` is written in UTC so the same chat
 * exports to the same text on every machine.
 */
export function threadToMarkdown(
  title: string,
  messages: UIMessage[],
  exportedAt: Date
): string {
  const stamp = exportedAt.toISOString().slice(0, 16).replace('T', ' ')
  const sections = [`# ${title}`, `_Exported from Atomic Chat on ${stamp} UTC_`]
  for (const message of messages) {
    const body = (message.parts ?? [])
      .map(partMarkdown)
      .filter((text): text is string => Boolean(text))
    if (body.length === 0) continue
    sections.push(`## ${roleHeading(message.role)}`, ...body)
  }
  return `${sections.join('\n\n')}\n`
}
