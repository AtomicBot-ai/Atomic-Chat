import { piEffort } from '@/lib/pi/effort'
import { toast } from 'sonner'
import { create } from 'zustand'
import type { UIMessage } from 'ai'
import { MessageStatus, type ThreadMessage } from '@janhq/core'
import {
  getSamplingParamsForThread,
  resolveAssistantForThread,
} from '@/lib/samplingParams'
import { modelSamplingParams } from '@/lib/model-sampling'
import { RUN_SETTINGS_SAMPLING_KEYS } from '@/lib/sampling-defaults'
import { renderInstructions } from '@/lib/instructionTemplate'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAppState } from '@/hooks/useAppState'
import type { InitialMessageFile } from '@/hooks/useInitialMessage'
import {
  extractContentPartsFromUIMessage,
  convertThreadMessagesToUIMessages,
} from '@/lib/messages'
import {
  servedModel,
  ensureServedModelRunning,
  loadServedModel,
} from '@/utils/servedModel'
import { isLocalProvider } from '@/utils/registerRemoteProvider'
import { startLocalApiServer } from '@/utils/localApiServerControl'
import { getModelContextLength } from '@/utils/apiServerCapacity'
import { requireAgentContextWindow } from '@/lib/agent-context-window'
import { resolveMcpAutoApprove } from '@/lib/mcp-approval'
import {
  connectorEnabled,
  piConnectors,
  piModelAvailable,
} from '@/lib/pi/integrations'
import { INTEGRATION_AGENTS } from '@/constants/integrations'
import {
  callPi,
  startPi,
  replyPi,
  attachPi,
  strataSessionWindow,
} from '@/services/pi-agent/tauri'
import {
  historyFromEntries,
  reducePiEvent,
  type PiEvent,
  type Dialog,
  type Entry,
} from '@/lib/pi/protocol'

type Translate = (key: string, options?: Record<string, unknown>) => string
type View = {
  messages: UIMessage[]
  streaming: boolean
  fileRevision: number
  starting: boolean
  error?: string
  dialogs: Dialog[]
  queue: string[]
  sessionModel?: ThreadModel
  commands: string[]
  status?: string
  context?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}
export const emptyView: View = {
  messages: [],
  streaming: false,
  fileRevision: 0,
  starting: false,
  dialogs: [],
  queue: [],
  commands: [],
}
export const usePiStore = create<{ threads: Record<string, View> }>(() => ({
  threads: {},
}))
const current = (id: string) => usePiStore.getState().threads[id] ?? emptyView
function update(id: string, change: Partial<View>) {
  usePiStore.setState((state) => ({
    threads: { ...state.threads, [id]: { ...current(id), ...change } },
  }))
}
const saves = new Map<string, Promise<void>>()
const persisted = new Map<string, Map<string, string>>()
const generation = new Map<string, number>()
function error(id: string, reason: unknown) {
  update(id, { error: String(reason), starting: false })
}

export async function openAgentHistory(id: string) {
  if (usePiStore.getState().threads[id]) return
  const rows = await getServiceHub().messages().fetchMessages(id)
  if (!usePiStore.getState().threads[id])
    update(id, { messages: convertThreadMessagesToUIMessages(rows) })
  if (!persisted.has(id))
    persisted.set(id, new Map(rows.map((row) => [row.id, ''])))
}

export async function reconnectAgent(id: string) {
  await openAgentHistory(id)
  const serial = (generation.get(id) ?? 0) + 1
  generation.set(id, serial)
  if (!(await attachPi(id, (event) => receive(id, serial, event)))) {
    if (generation.get(id) === serial)
      update(id, { context: undefined, streaming: false })
    return
  }
  const [state, commands] = await Promise.all([
    callPi<{ isStreaming: boolean; thinkingLevel: string }>(id, 'get_state'),
    callPi<{ commands: { name: string }[] }>(id, 'get_commands'),
  ])
  if (generation.get(id) !== serial) return
  update(id, {
    streaming: state.isStreaming,
    commands: [
      ...new Set(['name', 'compact', ...commands.commands.map((c) => c.name)]),
    ],
  })
  await Promise.all([scheduleSave(id, serial), refreshAgentContext(id, serial)])
}

async function saveHistory(id: string, serial: number) {
  if (generation.get(id) !== serial) return
  const { entries } = await callPi<{ entries: Entry[] }>(id, 'get_entries')
  if (generation.get(id) !== serial) return
  const messages = historyFromEntries(entries)
  const saved = persisted.get(id) ?? new Map<string, string>()
  persisted.set(id, saved)
  const svc = getServiceHub().messages()
  for (const message of messages) {
    const signature = JSON.stringify(message)
    if (saved.get(message.id) === signature) continue
    const createdAt = (message.metadata as { createdAt: number }).createdAt
    const row: ThreadMessage = {
      id: message.id,
      object: 'thread.message',
      thread_id: id,
      role: message.role as ThreadMessage['role'],
      created_at: createdAt,
      completed_at: createdAt,
      status: MessageStatus.Ready,
      content: extractContentPartsFromUIMessage(message),
    }
    if (saved.has(message.id)) await svc.modifyMessage(row)
    else await svc.createMessage(row)
    saved.set(message.id, signature)
  }
  if (generation.get(id) === serial) {
    const live = current(id)
    if (!live.streaming) update(id, { messages })
    else {
      const recorded = new Set(
        messages.map(
          (m) =>
            'pi-live-' +
            m.role +
            '-' +
            (m.metadata as { createdAt: number }).createdAt
        )
      )
      update(id, {
        messages: [
          ...messages,
          ...live.messages.filter(
            (m) => m.id.startsWith('pi-live-') && !recorded.has(m.id)
          ),
        ],
      })
    }
  }
}
function scheduleSave(id: string, serial: number) {
  const next = (saves.get(id) ?? Promise.resolve())
    .then(() => saveHistory(id, serial))
    .catch((reason) => error(id, reason))
  saves.set(id, next)
  return next
}

function permission(dialog: Dialog):
  | {
      tool: string
      input: unknown
      connector?: { server: string; name: string }
    }
  | undefined {
  try {
    const value = JSON.parse(dialog.title ?? '')
    if (value.type === 'atomic-approval' && typeof value.tool === 'string')
      return value
  } catch {
    /* An ordinary extension dialog has a plain title. */
  }
}
export { permission }

async function permissionKey(
  id: string,
  rule: NonNullable<ReturnType<typeof permission>>
) {
  const project = useThreads.getState().threads[id]?.metadata?.project?.id
  const scope = project ? ['project', project] : []
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      rule.connector
        ? [
            ...scope,
            'mcp',
            rule.connector.server,
            rule.connector.name,
            rule.input,
          ]
        : [...scope, rule.tool, rule.input]
    )
  )
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

async function handleDialog(id: string, serial: number, dialog: Dialog) {
  const rule = permission(dialog)
  if (
    rule?.connector &&
    !connectorEnabled(id, rule.connector.server, rule.connector.name)
  ) {
    await answerPi(id, dialog, 'Deny')
    return
  }
  const approved =
    rule &&
    (useAgentMode.getState().getApprovalMode(id) === 'skip' ||
      (rule.connector && resolveMcpAutoApprove(id)) ||
      useThreads
        .getState()
        .threads[
          id
        ]?.metadata?.piAllowed?.includes(await permissionKey(id, rule)))
  if (
    generation.get(id) !== serial ||
    !current(id).dialogs.some((d) => d.id === dialog.id)
  )
    return
  if (approved) await answerPi(id, dialog, 'Allow')
}

export async function answerPi(
  id: string,
  dialog: Dialog,
  value?: string,
  remember = false
) {
  const rule = permission(dialog)
  if (
    value === 'Allow' &&
    rule?.connector &&
    !connectorEnabled(id, rule.connector.server, rule.connector.name)
  ) {
    value = 'Deny'
    remember = false
  }
  await replyPi(
    id,
    dialog.id,
    value === undefined
      ? { cancelled: true }
      : dialog.method === 'confirm'
        ? { confirmed: value === 'Allow' }
        : { value }
  )
  update(id, {
    dialogs: current(id).dialogs.filter((item) => item.id !== dialog.id),
  })
  if (rule && remember && value === 'Allow') {
    const signature = await permissionKey(id, rule)
    const store = useThreads.getState()
    const thread = store.threads[id]
    if (!thread) return
    store.updateThread(id, {
      metadata: {
        piAllowed: [
          ...new Set([...(thread.metadata?.piAllowed ?? []), signature]),
        ],
      },
    })
  }
}

async function refreshAgentContext(id: string, serial: number) {
  const stats = await callPi<{ contextUsage?: View['context'] }>(
    id,
    'get_session_stats'
  )
  if (generation.get(id) === serial) update(id, { context: stats.contextUsage })
}

export async function compactAgent(id: string, t: Translate) {
  if (current(id).status === 'compaction_start') return
  const serial = generation.get(id)
  update(id, { status: 'compaction_start', error: undefined })
  try {
    await callPi(id, 'compact')
    if (serial !== undefined) await refreshAgentContext(id, serial)
  } catch (reason) {
    if (/nothing to compact|already compacted/i.test(String(reason)))
      toast.info(t('chat:contextCompaction.nothing'))
    else error(id, reason)
  } finally {
    if (generation.get(id) === serial) update(id, { status: undefined })
  }
}

function receive(id: string, serial: number, event: PiEvent) {
  if (generation.get(id) !== serial) return
  const view = current(id)
  switch (event.type) {
    case 'agent_start':
      update(id, { streaming: true, starting: false, error: undefined })
      break
    case 'agent_settled':
      update(id, {
        streaming: false,
        starting: false,
        dialogs: [],
        status: undefined,
      })
      scheduleSave(id, serial)
      void refreshAgentContext(id, serial).catch((reason) => error(id, reason))
      break
    case 'exit':
      update(id, {
        context: undefined,
        starting: false,
        streaming: false,
        dialogs: [],
        status: undefined,
        error: view.streaming
          ? event.stderrTail || 'pi exited during the turn'
          : view.error,
      })
      break
    case 'session_info_changed':
      if (event.name?.trim()) useThreads.getState().renameThread(id, event.name)
      break
    case 'extension_ui_request': {
      if (
        ['select', 'confirm', 'input', 'editor'].includes(event.method ?? '') &&
        event.id
      ) {
        const dialog = event as Dialog
        update(id, {
          dialogs: [...view.dialogs.filter((d) => d.id !== dialog.id), dialog],
        })
        void handleDialog(id, serial, dialog).catch((reason) =>
          error(id, reason)
        )
      } else if (event.method === 'notify')
        update(id, { status: String(event.message ?? '') })
      break
    }
    case 'queue_update':
      update(id, {
        queue: [...(event.steering ?? []), ...(event.followUp ?? [])],
      })
      break
    case 'compaction_start':
    case 'auto_retry_start':
      update(id, { status: event.type })
      break
    case 'compaction_end':
    case 'auto_retry_end':
      update(id, { status: undefined })
      break
    default: {
      if (
        event.type === 'tool_execution_end' &&
        !event.isError &&
        ['write', 'edit', 'bash', 'powershell'].includes(event.toolName ?? '')
      ) {
        update(id, { fileRevision: view.fileRevision + 1 })
      }
      const messages = reducePiEvent(view.messages, event)
      if (messages !== view.messages) update(id, { messages })
      if (event.type === 'message_end') {
        if (typeof event.message === 'object' && event.message.errorMessage)
          update(id, { error: event.message.errorMessage })
      }
    }
  }
}

export async function sendAgent(
  id: string,
  text: string,
  files: InitialMessageFile[] | undefined,
  t: Translate
) {
  const thread = useThreads.getState().threads[id]
  const agent = thread?.metadata?.agent
  if (!agent || current(id).starting) return
  try {
    const images = (files ?? []).map((file) => {
      const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(file.url)
      if (!match) throw new Error(t('chat:pi.imageOnly'))
      return { type: 'image', mimeType: match[1], data: match[2] }
    })
    if (current(id).streaming) {
      const sessionModel = current(id).sessionModel ?? thread.model
      const served =
        sessionModel &&
        useModelProvider
          .getState()
          .getProviderByName(sessionModel.provider)
          ?.models.find((m) => m.id === sessionModel.id)
      if (sessionModel && served)
        await callPi(id, 'set_thinking_level', {
          level: piEffort(sessionModel.provider, served).level,
        })
      await callPi(id, 'steer', { message: text, images })
      return
    }
    await openAgentHistory(id)
    if (current(id).starting) return
    update(id, { starting: true, error: undefined })
    await useThreads.getState().awaitThreadPersistence(id)
    if (useAppState.getState().serverStatus !== 'running') {
      try {
        await startLocalApiServer()
      } catch (e) {
        if (!String(e).includes('already running')) throw e
      }
      useAppState.getState().setServerStatus('running')
    }
    let target = servedModel()
    if (target) await ensureServedModelRunning()
    else {
      const { selectedModel, selectedProvider } = useModelProvider.getState()
      if (selectedModel && selectedProvider) {
        target = { model: selectedModel.id, provider: selectedProvider }
        if (isLocalProvider(selectedProvider))
          await loadServedModel(getServiceHub().models(), target)
      }
    }
    const provider = useModelProvider
      .getState()
      .getProviderByName(target?.provider ?? '')
    const model = provider?.models.find((m) => m.id === target?.model)
    if (!target || !model || !piModelAvailable(provider, model))
      throw new Error(t('chat:pi.modelRequired'))
    const pi = INTEGRATION_AGENTS.find((a) => a.id === 'pi')
    if (!pi) throw new Error(t('chat:pi.unavailable'))
    const server = useLocalApiServer.getState()
    const baseUrl = `http://127.0.0.1:${server.serverPort}/${server.apiPrefix.replace(/^\/+|\/+$/g, '')}`
    const contextWindow =
      target.provider === 'strata'
        ? await strataSessionWindow(baseUrl, server.apiKey, target.model)
        : ((await requireAgentContextWindow(pi, t, target)) ??
          getModelContextLength(target.model, target.provider) ??
          pi.minContextLength!)
    if (
      contextWindow === undefined ||
      (target.provider === 'strata' && contextWindow < pi.minContextLength!)
    )
      throw new Error(
        t('chat:pi.strataContext', { minimum: pi.minContextLength })
      )
    const serial = (generation.get(id) ?? 0) + 1
    generation.set(id, serial)
    const projectId = thread.metadata?.project?.id
    const project = projectId
      ? await getServiceHub().projects().getProjectById(projectId)
      : undefined
    const assistant = resolveAssistantForThread(id, project?.assistantId)
    const localModel = isLocalProvider(target.provider)
    const params = localModel
      ? modelSamplingParams(
          target.provider,
          target.model,
          provider?.settings,
          getSamplingParamsForThread(id, project?.assistantId)
        )
      : {}
    const sampling = Object.fromEntries(
      Object.entries(params).filter(
        ([key, value]) =>
          RUN_SETTINGS_SAMPLING_KEYS.includes(key) &&
          typeof value === 'number' &&
          Number.isFinite(value)
      )
    ) as Record<string, number>
    const effort = piEffort(target.provider, model)
    const info = await startPi(
      {
        threadId: id,
        cwd: agent.cwd,
        sessionFile: agent.sessionFile,
        baseUrl,
        apiKey: server.apiKey,
        model: target.model,
        contextWindow,
        reasoning: effort.supportsThinking,
        thinkingLevel: effort.level,
        thinkingLevelMap: effort.map,
        reasoningFields: effort.fields,
        vision: Boolean(model.capabilities?.includes('vision')),
        provider: target.provider,
        connectors: await piConnectors(id),
        assistantInstructions: renderInstructions(assistant?.instructions),
        sampling,
        localModel,
      },
      (event) => receive(id, serial, event)
    )
    if (agent.sessionFile !== info.sessionFile)
      useThreads.getState().updateThread(id, {
        metadata: { agent: { ...agent, sessionFile: info.sessionFile } },
      })
    const [commands, state] = await Promise.all([
      callPi<{ commands: { name: string }[] }>(id, 'get_commands'),
      callPi<{ thinkingLevel: string }>(id, 'get_state'),
    ])
    // A resumed session can carry the level of its previous turn.
    if (state.thinkingLevel !== effort.level)
      await callPi(id, 'set_thinking_level', { level: effort.level })
    update(id, {
      sessionModel: { id: target.model, provider: target.provider },
      commands: [
        ...new Set([
          'name',
          'compact',
          ...commands.commands.map((c) => c.name),
        ]),
      ],
    })
    const rename = !images.length && /^\/name\s+(.+)$/s.exec(text.trim())
    if (rename || (!images.length && text.trim() === '/compact')) {
      if (rename)
        await callPi(id, 'set_session_name', { name: rename[1].trim() })
      else await compactAgent(id, t)
      update(id, { starting: false })
      return
    }
    const response = await callPi<{ disposition: string }>(id, 'prompt', {
      message: text,
      images,
    })
    update(id, { starting: false })
    if (response.disposition === 'handled') scheduleSave(id, serial)
  } catch (reason) {
    if (!usePrompt.getState().getDraft(id))
      usePrompt.getState().setDraft(id, text)
    error(id, reason)
  }
}
export async function agentAction(
  id: string,
  command: string,
  fields: Record<string, unknown> = {}
) {
  try {
    await callPi(id, command, fields)
  } catch (reason) {
    error(id, reason)
  }
}
