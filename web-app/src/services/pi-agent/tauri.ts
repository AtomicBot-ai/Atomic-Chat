import { Channel, invoke } from '@tauri-apps/api/core'
import type { MCPTool } from '@/types/completion'
import type { PiEvent } from '@/lib/pi/protocol'

export type PiStart = {
  threadId: string
  cwd: string
  sessionFile?: string
  baseUrl: string
  apiKey: string
  model: string
  contextWindow: number
  reasoning: boolean
  vision: boolean
  provider: string
  assistantInstructions?: string
  sampling?: Record<string, number>
  connectors: MCPTool[]
  localModel: boolean
  thinkingLevel?: string
  thinkingLevelMap?: Record<string, string | null>
  reasoningFields?: Record<string, Record<string, unknown>>
}

export function startPi(request: PiStart, receive: (event: PiEvent) => void) {
  const onEvent = new Channel<PiEvent>()
  onEvent.onmessage = receive
  return invoke<{ sessionFile: string; model: string }>('pi_agent_start', {
    request,
    onEvent,
  })
}
export const callPi = <T = unknown>(
  threadId: string,
  type: string,
  fields: Record<string, unknown> = {}
) => invoke<T>('pi_agent_call', { threadId, command: { ...fields, type } })
export const replyPi = (
  threadId: string,
  id: string,
  result: { value?: string; confirmed?: boolean; cancelled?: boolean }
) =>
  invoke<void>('pi_agent_ui_respond', {
    threadId,
    response: { type: 'extension_ui_response', id, ...result },
  })
export const piStatus = () =>
  invoke<{ available: boolean; version: string }>('pi_agent_status')

export function attachPi(threadId: string, receive: (event: PiEvent) => void) {
  const onEvent = new Channel<PiEvent>()
  onEvent.onmessage = receive
  return invoke<boolean>('pi_agent_attach', { threadId, onEvent })
}

/** The public API reports the effective Strata session window, including automatic sizing. */
export async function strataSessionWindow(
  baseUrl: string,
  apiKey: string | undefined,
  model: string
) {
  const raw = await invoke<string>('get_local_http', {
    url: baseUrl + '/models',
    headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
    timeoutSecs: 5,
  })
  const { data } = JSON.parse(raw) as {
    data: { id: string; owned_by: string; context_length?: number }[]
  }
  const size = data.find(
    (entry) => entry.id === model && entry.owned_by === 'strata'
  )?.context_length
  return size && Number.isSafeInteger(size) && size > 0 ? size : undefined
}
