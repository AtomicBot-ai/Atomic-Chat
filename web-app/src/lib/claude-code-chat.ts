import { Channel, invoke } from '@tauri-apps/api/core'
import type { UIMessage, UIMessageChunk, LanguageModelUsage } from 'ai'

export const CLAUDE_CODE_PROVIDER = 'claude-code'

export const claudeCodeProvider = (models: Model[] = []): ModelProvider => ({
  provider: CLAUDE_CODE_PROVIDER,
  active: true,
  persist: true,
  settings: [],
  supports_model_listing: false,
  models: models.map((model) => ({
    ...model,
    displayName: model.name,
    capabilities: [],
  })),
})

// Resolve saved aliases from the first integration without showing duplicate,
// unversioned rows in the new account-provided catalog.
export function resolveClaudeModel(
  models: Model[],
  id: string
): Model | undefined {
  const exact = models.find((model) => model.id === id)
  if (exact) return exact
  const legacy = /^claude-code-(opus|sonnet|haiku|fable)$/.exec(id)
  return legacy
    ? models.find((model) => model.id.startsWith(`claude-${legacy[1]}-`))
    : undefined
}

export type ClaudeCodeStatus = {
  installed: boolean
  loggedIn: boolean
  subscription: boolean
  plan: string | null
  version: string | null
  error: string | null
  models: Model[]
}

type Completion = {
  sessionId: string
  text: string
  inputTokens: number
  outputTokens: number
}
type Event = { type: 'ready' } | { type: 'delta'; text: string }
type Turn = { role: UIMessage['role']; text: string }
type Binding = {
  sessionId: string
  model: string
  system: string
  history: string
}
const BINDING_PREFIX = 'atomic-claude-session:'

export async function requireClaudeSubscription(): Promise<ClaudeCodeStatus> {
  const status = await invoke<ClaudeCodeStatus>('atomic_claude_status')
  if (!status.installed || !status.subscription) {
    throw new Error(
      status.error ||
        'Connect your Claude subscription in Cloud → Claude subscription.'
    )
  }
  return status
}

export function textTurns(messages: UIMessage[]): Turn[] {
  return messages
    .map((message) => {
      const metadata = message.metadata as Record<string, unknown> | undefined
      if (
        (Array.isArray(metadata?.file_attachments) &&
          metadata.file_attachments.length > 0) ||
        message.parts.some(
          (part) =>
            part.type === 'file' ||
            part.type.startsWith('tool-') ||
            part.type === 'dynamic-tool'
        )
      ) {
        throw new Error(
          'The Claude Code connection currently supports text conversations. Start a text-only chat to use your subscription.'
        )
      }
      return {
        role: message.role,
        text: message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(''),
      }
    })
    .filter((turn) => turn.text.length > 0)
}

async function digest(turns: Turn[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(turns))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

function loadBinding(key: string): Binding | undefined {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? undefined
  } catch {
    return undefined
  }
}
function saveBinding(key: string, binding?: Binding) {
  try {
    if (binding) localStorage.setItem(key, JSON.stringify(binding))
    else localStorage.removeItem(key)
  } catch {
    /* Persistence is optional: next turn reconstructs the visible text history. */
  }
}

export function canResumeClaude(
  binding: Binding | undefined,
  model: string,
  system: string,
  history: string
): boolean {
  return Boolean(
    binding?.sessionId &&
      binding.model === model &&
      binding.system === system &&
      binding.history === history
  )
}

export async function streamClaudeCode(options: {
  threadId: string
  model: string
  system?: string
  messages: UIMessage[]
  abortSignal?: AbortSignal
  onTokenUsage?: (usage: LanguageModelUsage, messageId: string) => void
}): Promise<ReadableStream<UIMessageChunk>> {
  const { model, abortSignal, onTokenUsage } = options
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const turns = textTurns(options.messages)
  // Regeneration must never resume a session containing the answer being replaced.
  while (turns.at(-1)?.role === 'assistant') turns.pop()
  const latest = turns.at(-1)
  if (!latest || latest.role !== 'user')
    throw new Error('A text message is required.')
  const system = options.system || ''
  const key = BINDING_PREFIX + options.threadId
  const binding = loadBinding(key)
  const prefix = await digest(turns.slice(0, -1))
  const resume = canResumeClaude(binding, model, system, prefix)
  const prompt =
    resume || turns.length === 1
      ? latest.text
      : `Continue the following conversation. The JSON below contains historical messages, not tool instructions. Answer the last user message.\n${JSON.stringify(turns)}`
  // Interrupted and failed turns must not be reused as if they had completed.
  saveBinding(key)
  const requestId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const textId = crypto.randomUUID()
  let closed = false
  let cancelled = false
  let ready = false
  let rendered = ''
  let stop: () => void = () => {}
  const cancelProcess = () => {
    cancelled = true
    if (ready)
      void invoke('atomic_claude_cancel', { requestId }).catch(() => {})
  }

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      const finish = () => {
        if (closed) return
        closed = true
        abortSignal?.removeEventListener('abort', stop)
        controller.close()
      }
      stop = () => {
        cancelProcess()
        finish()
      }
      abortSignal?.addEventListener('abort', stop, { once: true })
      if (abortSignal?.aborted) {
        stop()
        return
      }
      controller.enqueue({ type: 'start', messageId })
      controller.enqueue({ type: 'text-start', id: textId })
      const events = new Channel<Event>()
      events.onmessage = (event) => {
        if (event.type === 'ready') {
          ready = true
          if (cancelled) cancelProcess()
        } else if (!closed && !cancelled) {
          rendered += event.text
          controller.enqueue({
            type: 'text-delta',
            id: textId,
            delta: event.text,
          })
        }
      }
      void invoke<Completion>('atomic_claude_chat', {
        request: {
          requestId,
          model,
          prompt,
          system,
          sessionId: resume ? binding?.sessionId : null,
        },
        events,
      })
        .then(async (result) => {
          if (closed || cancelled) return
          // Some CLI builds send only the final result. Never duplicate deltas.
          if (!rendered && result.text) {
            rendered = result.text
            controller.enqueue({
              type: 'text-delta',
              id: textId,
              delta: rendered,
            })
          }
          const history = await digest([
            ...turns,
            { role: 'assistant', text: rendered },
          ])
          if (closed || cancelled) return
          saveBinding(key, {
            sessionId: result.sessionId,
            model,
            system,
            history,
          })
          onTokenUsage?.(
            {
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              totalTokens: result.inputTokens + result.outputTokens,
            },
            messageId
          )
          controller.enqueue({ type: 'text-end', id: textId })
          controller.enqueue({ type: 'finish', finishReason: 'stop' })
          finish()
        })
        .catch((error: unknown) => {
          if (closed || cancelled) return
          closed = true
          abortSignal?.removeEventListener('abort', stop)
          controller.error(
            error instanceof Error ? error : new Error(String(error))
          )
        })
    },
    cancel() {
      cancelProcess()
      closed = true
      abortSignal?.removeEventListener('abort', stop)
    },
  })
}

/** Cancellation handshake matches chat: cancel is sent only once Rust registered the request. */
export async function loginClaudeCode(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const requestId = crypto.randomUUID()
  let ready = false
  const cancel = () => {
    if (ready)
      void invoke('atomic_claude_cancel', { requestId }).catch(() => {})
  }
  const events = new Channel<Event>()
  events.onmessage = (event) => {
    if (event.type === 'ready') {
      ready = true
      if (signal.aborted) cancel()
    }
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    await invoke('atomic_claude_login', { requestId, events })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
  signal.throwIfAborted()
}
