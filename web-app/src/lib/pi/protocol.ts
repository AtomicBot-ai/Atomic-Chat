import type { UIMessage } from 'ai'

export type Block = {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  mimeType?: string
  data?: string
}
export type PiMessage = {
  role: string
  timestamp: number
  content: Block[] | string
  toolCallId?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
}
export type Entry = { type: string; id: string; message?: PiMessage }
export type Dialog = {
  id: string
  method: string
  title?: string
  options?: string[]
  message?: string
}
export type PiEvent = Partial<Omit<Dialog, 'message'>> & {
  type: string
  message?: string | PiMessage
  toolName?: string
  toolCallId?: string
  isError?: boolean
  result?: { content?: Block[] }
  partialResult?: { content?: Block[] }
  assistantMessageEvent?: {
    type: string
    contentIndex: number
    delta?: string
    content?: string
    toolCall?: Block
  }
  steering?: string[]
  followUp?: string[]
  code?: number
  stderrTail?: string
  name?: string
}

type Part = UIMessage['parts'][number]
function part(block: Block): Part | undefined {
  if (block.type === 'text') return { type: 'text', text: block.text ?? '' }
  if (block.type === 'thinking')
    return { type: 'reasoning', text: block.thinking ?? '' }
  if (block.type === 'image' && block.data && block.mimeType)
    return {
      type: 'file',
      mediaType: block.mimeType,
      url: `data:${block.mimeType};base64,${block.data}`,
    }
  if (block.type === 'toolCall' && block.id && block.name)
    return {
      type: `tool-${block.name}`,
      toolCallId: block.id,
      input: block.arguments ?? {},
      state: 'input-available',
    }
}
// Pi expands a skill command into its file contents for the model. Show the
// invocation in the transcript while the original pi session retains the body.
function userSkillText(text: string) {
  const block =
    /^<skill name="([a-z0-9-]+)" location="[^"\n]+">\nReferences are relative to [^\n]+\.\n\n[\s\S]*?\n<\/skill>(?:\n\n|$)/.exec(
      text
    )
  return block
    ? ('/' + block[1] + ' ' + text.slice(block[0].length)).trimEnd()
    : text
}

export function messageToUi(
  message: PiMessage,
  id: string
): UIMessage | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return
  const parts =
    typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : (message.content ?? [])
          .map(part)
          .filter((p): p is Part => p !== undefined)
  return {
    id,
    role: message.role,
    parts:
      message.role === 'user'
        ? parts.map((p) =>
            p.type === 'text' ? { ...p, text: userSkillText(p.text) } : p
          )
        : parts,
    metadata: { createdAt: message.timestamp },
  }
}
function output(
  messages: UIMessage[],
  call: string | undefined,
  content: Block[] | string,
  failed?: boolean,
  partial = false
) {
  return messages.map((message) => {
    const matched = message.parts.findIndex(
      (p) => 'toolCallId' in p && p.toolCallId === call
    )
    if (matched < 0) return message
    const parts = [...message.parts]
    const text =
      typeof content === 'string'
        ? content
        : content.map((block) => block.text ?? '').join('\n')
    parts[matched] = {
      ...parts[matched],
      ...(failed
        ? { state: 'output-error', errorText: text }
        : {
            state: partial ? 'input-available' : 'output-available',
            output: text,
          }),
    } as Part
    return { ...message, parts }
  })
}
export function historyFromEntries(entries: Entry[]): UIMessage[] {
  let messages: UIMessage[] = []
  for (const entry of entries) {
    if (entry.type !== 'message' || !entry.message) continue
    const message = messageToUi(entry.message, entry.id)
    if (message) messages.push(message)
    else if (entry.message.role === 'toolResult')
      messages = output(
        messages,
        entry.message.toolCallId,
        entry.message.content,
        entry.message.isError
      )
  }
  return messages
}
export function reducePiEvent(
  messages: UIMessage[],
  event: PiEvent
): UIMessage[] {
  if (event.type === 'message_start' || event.type === 'message_end') {
    const msg = event.message
    if (!msg || typeof msg === 'string') return messages
    const id = `pi-live-${msg.role}-${msg.timestamp}`
    const next = messageToUi(msg, id)
    if (!next) return messages
    const index = messages.findIndex((m) => m.id === id)
    return index < 0
      ? [...messages, next]
      : messages.map((m, i) => (i === index ? next : m))
  }
  if (
    event.type === 'tool_execution_update' ||
    event.type === 'tool_execution_end'
  ) {
    return output(
      messages,
      event.toolCallId,
      (event.partialResult ?? event.result)?.content ?? [],
      event.isError,
      event.type === 'tool_execution_update'
    )
  }
  const delta = event.assistantMessageEvent
  const last = messages.at(-1)
  if (event.type !== 'message_update' || !delta || last?.role !== 'assistant')
    return messages
  const parts = [...last.parts]
  const previous = parts[delta.contentIndex]
  const type = delta.type.split('_')[0]
  if (type === 'text' || type === 'thinking') {
    const text =
      delta.content ??
      (previous && 'text' in previous ? previous.text : '') +
        (delta.delta ?? '')
    parts[delta.contentIndex] = {
      type: type === 'text' ? 'text' : 'reasoning',
      text,
    }
  } else if (delta.toolCall) {
    const tool = part(delta.toolCall)
    if (tool) parts[delta.contentIndex] = tool
  } else return messages
  return [...messages.slice(0, -1), { ...last, parts }]
}
