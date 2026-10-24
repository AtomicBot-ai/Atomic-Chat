import type { UIMessage } from 'ai'

export type MessageClockOptions = {
  include_date?: boolean
  include_time?: boolean
}

export type MessageClock = { date?: string; time?: string }

/** Capture once at send time. Never rewrite historical message text or clocks. */
export function captureMessageClock(
  options?: MessageClockOptions,
  now = new Date()
): MessageClock | undefined {
  const clock: MessageClock = {}
  const pad = (value: number) => String(value).padStart(2, '0')
  if (options?.include_date)
    clock.date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  if (options?.include_time)
    clock.time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return clock.date || clock.time ? clock : undefined
}

/** Only explicit app metadata is rendered; never parse date-looking user text. */
export function readMessageClock(metadata: unknown): MessageClock | undefined {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('message_clock' in metadata)
  )
    return undefined
  const value = metadata.message_clock
  if (!value || typeof value !== 'object') return undefined
  const date =
    'date' in value &&
    typeof value.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date)
      ? value.date
      : undefined
  const time =
    'time' in value &&
    typeof value.time === 'string' &&
    /^\d{2}:\d{2}:\d{2}$/.test(value.time)
      ? value.time
      : undefined
  return date || time ? { date, time } : undefined
}

export function messageClockLabel(metadata: unknown): string | undefined {
  const clock = readMessageClock(metadata)
  return clock ? [clock.date, clock.time].filter(Boolean).join(' ') : undefined
}

/** Rebuild the same model prefix from stored values on every history replay. */
export function prependStoredMessageClock(
  text: string,
  metadata: unknown
): string {
  const clock = readMessageClock(metadata)
  if (!clock) return text
  const fields = [
    clock.date && `Date: ${clock.date}`,
    clock.time && `Time: ${clock.time}`,
  ].filter(Boolean)
  return `[${fields.join(' | ')}]\n${text}`
}

/** Produce model-only copies; saved/UI text, copy and editing stay untouched. */
export function withMessageClocksForModel(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !readMessageClock(message.metadata))
      return message
    let prefixed = false
    const parts = message.parts.map((part) => {
      if (part.type !== 'text' || prefixed) return part
      prefixed = true
      return {
        ...part,
        text: prependStoredMessageClock(part.text, message.metadata),
      }
    })
    if (!prefixed)
      parts.unshift({
        type: 'text',
        text: prependStoredMessageClock('', message.metadata),
      })
    return { ...message, parts }
  })
}
