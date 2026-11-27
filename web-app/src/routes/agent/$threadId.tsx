import { useEffect, useState } from 'react'
import { createFileRoute, Navigate, redirect } from '@tanstack/react-router'
import { currentDesktopPlatform } from '@/constants/integrations'
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { AgentContextSizeControl } from '@/containers/ContextSizeControl'
import { HeaderContextSlot } from '@/containers/HeaderContextSize'
import ChatInput from '@/containers/ChatInput'
import { MessageItem } from '@/containers/MessageItem'
import AgentApprovalInline from '@/containers/AgentApprovalInline'
import { AgentWorkspaceLayout } from '@/containers/AgentWorkspaceLayout'
import ConversationHeader from '@/components/ConversationHeader'
import { useTools } from '@/hooks/useTools'
import { useThreads } from '@/hooks/useThreads'
import { getServiceHub } from '@/hooks/useServiceHub'
import { resolveAgentWorkspaceRoot } from '@/services/agent/tauri'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useInitialMessage } from '@/hooks/useInitialMessage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  agentAction,
  compactAgent,
  answerPi,
  emptyView,
  reconnectAgent,
  permission,
  sendAgent,
  usePiStore,
} from '@/stores/pi-agent-store'
import type { AgentApprovalResolution } from '@/types/agent'
import { useComposerSecureEnvironment } from '@/hooks/useSecureEnvironments'
import { usePrompt, selectDraft } from '@/hooks/usePrompt'
import type { Dialog } from '@/lib/pi/protocol'

export const Route = createFileRoute('/agent/$threadId')({
  beforeLoad: () => {
    if (!currentDesktopPlatform()) throw redirect({ to: '/' })
  },
  component: AgentThreadRoute,
})

function AgentThreadRoute() {
  const { threadId } = Route.useParams()
  const thread = useThreads((s) => s.threads[threadId])
  if (thread && thread.metadata?.kind !== 'agent')
    return <Navigate to="/threads/$threadId" params={{ threadId }} replace />
  return <AgentThread key={threadId} id={threadId} thread={thread} />
}

function PiDialog({
  id,
  dialog,
  onError,
}: {
  id: string
  dialog: Dialog
  onError: (e: string) => void
}) {
  const { t } = useTranslation()
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const rule = permission(dialog)
  async function respond(value?: string, always = false) {
    if (busy) return
    setBusy(true)
    try {
      await answerPi(id, dialog, value, always)
    } catch (e) {
      onError(String(e))
    } finally {
      setBusy(false)
    }
  }
  if (rule)
    return (
      <AgentApprovalInline
        threadId={id}
        actions={{
          approval: {
            type: 'approval_requested',
            run_id: id,
            approval_id: dialog.id,
            tool: rule.tool,
            reason: t('chat:pi.review'),
            preview: rule.input,
            affected_resources: [],
            can_remember: true,
          },
          folderAccess: undefined,
          approvalResolving: busy,
          folderAccessResolving: false,
          resolveApproval: async (decision: AgentApprovalResolution) =>
            respond(
              decision === 'deny' ? 'Deny' : 'Allow',
              decision === 'always_allow'
            ),
          resolveFolderAccess: async () => {},
        }}
      />
    )
  return (
    <div role="group" className="rounded-lg border bg-background p-3">
      <p>{dialog.title}</p>
      {dialog.message && <p>{dialog.message}</p>}
      {['input', 'editor'].includes(dialog.method) && (
        <input
          aria-label={dialog.title}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      )}
      {(dialog.method === 'select'
        ? (dialog.options ?? [])
        : [t('chat:pi.confirm')]
      ).map((v) => (
        <button
          type="button"
          disabled={busy}
          className="mx-1 underline"
          key={v}
          onClick={() =>
            void respond(
              dialog.method === 'confirm'
                ? 'Allow'
                : dialog.method === 'select'
                  ? v
                  : input
            )
          }
        >
          {v}
        </button>
      ))}
      <button type="button" disabled={busy} onClick={() => void respond()}>
        {t('common:cancel')}
      </button>
    </div>
  )
}
function AgentThread({ id, thread }: { id: string; thread?: Thread }) {
  useTools()
  const { t } = useTranslation()
  const view = usePiStore((s) => s.threads[id] ?? emptyView)
  const workspace = useAgentMode((s) => s.workspaces[id])
  const [localError, setError] = useState('')
  const prompt = usePrompt(selectDraft(id))
  const environment = useComposerSecureEnvironment(
    true,
    thread?.metadata?.project?.id
  )
  const cwd = environment
    ? (
        environment.folders.find((folder) => folder.canEdit) ??
        environment.folders[0]
      )?.path
    : thread?.metadata?.agent?.cwd
  const exists = Boolean(thread?.metadata?.agent)
  useEffect(() => {
    if (!exists) return
    let active = true
    useThreads.getState().setCurrentThreadId(id)
    void reconnectAgent(id)
      .then(() => {
        if (!active) return
        const initial = useInitialMessage.getState().consume(id)
        if (initial) void sendAgent(id, initial.text, initial.files, t)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [id, exists, t])
  if (!thread) return <div className="p-4">{t('chat:pi.loading')}</div>
  const dialog = view.dialogs[0]
  async function addFolder() {
    const path = await getServiceHub()
      .dialog()
      .open({ directory: true, multiple: false })
    if (typeof path === 'string')
      useAgentMode.getState().addExternalRoot(id, {
        ...(await resolveAgentWorkspaceRoot(path)),
        canEdit: false,
      })
  }
  return (
    <AgentWorkspaceLayout
      threadId={id}
      piAgent
      workspace={workspace ?? { externalRoots: [] }}
      onAddExternal={() => void addFolder().catch((e) => setError(String(e)))}
      refreshKey={view.fileRevision}
      isGenerating={view.streaming}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <ConversationHeader mode="agent">
          <div className="flex w-full min-w-0 items-center justify-between">
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
              {thread.title}
            </h1>
            {view.context &&
              view.context.tokens != null &&
              view.context.contextWindow > 0 && (
                <HeaderContextSlot>
                  <AgentContextSizeControl
                    tokens={view.context.tokens}
                    capacity={view.context.contextWindow}
                    busy={
                      view.streaming ||
                      view.starting ||
                      view.status === 'compaction_start'
                    }
                    onCompact={() => void compactAgent(id, t)}
                  />
                </HeaderContextSlot>
              )}
          </div>
        </ConversationHeader>
        <div className="relative min-h-0 flex-1">
          <Conversation className="absolute inset-0 text-start">
            <ConversationContent className="mx-auto w-full max-w-3xl md:w-4/5 xl:w-4/6">
              {view.messages.map((message, i) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  status={view.streaming ? 'streaming' : 'ready'}
                  isFirstMessage={i === 0}
                  isLastMessage={i === view.messages.length - 1}
                  hideActions
                />
              ))}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>
        <div className="mx-auto w-full min-w-0 py-4 md:w-4/5 xl:w-4/6">
          {(localError || view.error) && (
            <p
              role="alert"
              className="break-words px-2 text-sm text-destructive"
            >
              {localError || view.error}
            </p>
          )}
          {view.status && (
            <p role="status" className="text-sm">
              {['auto_retry_start', 'compaction_start'].includes(view.status)
                ? t(`chat:pi.${view.status}`)
                : view.status}
            </p>
          )}
          {(view.status === 'auto_retry_start' || view.queue.length > 0) && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {view.status === 'auto_retry_start' && (
                <button onClick={() => void agentAction(id, 'abort_retry')}>
                  {t('common:stop')}
                </button>
              )}
              {view.queue.map((text, i) => (
                <span
                  key={i}
                  className="max-w-40 truncate rounded bg-muted px-2"
                >
                  {text}
                </span>
              ))}
              {!!view.queue.length && (
                <button
                  type="button"
                  onClick={() => void agentAction(id, 'clear_queue')}
                >
                  {t('chat:pi.clearQueue')}
                </button>
              )}
            </div>
          )}
          {prompt.startsWith('/') &&
            !prompt.includes(' ') &&
            view.commands.some((c) => c.startsWith(prompt.slice(1))) && (
              <div
                aria-label={t('chat:pi.commands')}
                className="flex flex-wrap gap-2"
              >
                {view.commands
                  .filter((c) => c.startsWith(prompt.slice(1)))
                  .slice(0, 12)
                  .map((c) => (
                    <button
                      key={c}
                      onClick={() =>
                        usePrompt.getState().setDraft(id, '/' + c + ' ')
                      }
                    >
                      /{c}
                    </button>
                  ))}
              </div>
            )}
          <ChatInput
            mode="agent"
            threadId={id}
            projectId={thread.metadata?.project?.id}
            workspaceFolder={
              cwd
                ? {
                    path: cwd,
                    onClick: () =>
                      void getServiceHub()
                        .opener()
                        .openPath(cwd)
                        .catch((e) => setError(String(e))),
                  }
                : undefined
            }
            chatStatus={
              view.streaming
                ? 'streaming'
                : view.starting
                  ? 'submitted'
                  : 'ready'
            }
            approvalSlot={
              dialog && (
                <PiDialog
                  key={dialog.id}
                  id={id}
                  dialog={dialog}
                  onError={setError}
                />
              )
            }
            onStop={() => void agentAction(id, 'abort')}
            onSubmit={(text, files) => void sendAgent(id, text, files, t)}
          />
        </div>
      </div>
    </AgentWorkspaceLayout>
  )
}
